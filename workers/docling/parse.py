"""Docling layout adapter for papers.

Usage: parse.py INPUT.pdf ASSET_DIR
Stdout is one JSON object: {"pageCount": n, "blocks": [...]}. Figure and
fallback formula images are written to ASSET_DIR as figure-N.png.
"""
import contextlib
import json
import re
import sys

NUMBERING = re.compile(r"^(\d+(?:\.\d+)*|[A-Z](?:\.\d+)*)\.?\s+\S")
REFERENCES = re.compile(r"^(?:\d+\.?\s*)?(?:references|bibliography)$", re.I)


def convert(path, ocr):
    from docling.datamodel.base_models import InputFormat
    from docling.datamodel.pipeline_options import PdfPipelineOptions
    from docling.document_converter import DocumentConverter, PdfFormatOption

    options = PdfPipelineOptions()
    options.do_ocr = ocr
    options.do_table_structure = True
    options.do_formula_enrichment = True
    options.generate_picture_images = True
    options.generate_page_images = True  # Crops formulas that could not be read as LaTeX.
    options.images_scale = 2.0
    converter = DocumentConverter(format_options={InputFormat.PDF: PdfFormatOption(pipeline_options=options)})
    return converter.convert(path).document


def table_markdown(item):
    rows = [[" ".join(cell.text.split()) for cell in row] for row in item.data.grid]
    rows = [row for row in rows if any(row)]
    if not rows:
        return ""
    width = max(len(row) for row in rows)
    line = lambda row: "| " + " | ".join((row[i] if i < len(row) else "").replace("|", "\\|") for i in range(width)) + " |"
    return "\n".join([line(rows[0]), "|" + " --- |" * width, *map(line, rows[1:])])


def heading_level(text, first):
    if first:
        return 1
    match = NUMBERING.match(text)
    return min(4, match.group(1).count(".") + 2) if match else 2


def blocks_from(document, asset_dir):
    from docling_core.types.doc import CodeItem, DocItemLabel, FormulaItem, GroupItem, GroupLabel, ListItem, PictureItem, SectionHeaderItem, TableItem, TextItem

    blocks, skipped, figures = [], set(), 0
    in_references, seen_heading = False, False

    def save_image(item):
        nonlocal figures
        image = item.get_image(document)
        if image is None:
            return None
        figures += 1
        name = f"figure-{figures}.png"
        image.save(f"{asset_dir}/{name}", "PNG", optimize=True)
        return name

    def page(item):
        return item.prov[0].page_no if getattr(item, "prov", None) else None

    def inline_text(group):
        parts = []
        for ref in group.children:
            child = ref.resolve(document)
            skipped.add(child.self_ref)
            if isinstance(child, FormulaItem):
                parts.append(f"${child.text.strip()}$" if child.text.strip() else (child.orig or ""))
            elif isinstance(child, TextItem):
                parts.append(child.text)
        return " ".join(part for part in parts if part).strip()

    for item, _level in document.iterate_items(with_groups=True):
        if item.self_ref in skipped:
            continue
        if isinstance(item, GroupItem):
            if item.label == GroupLabel.INLINE:
                text = inline_text(item)
                first_child = item.children[0].resolve(document) if item.children else None
                if text:
                    blocks.append({"type": "reference" if in_references else "paragraph", "text": text, "page": page(first_child) if first_child else None})
            continue
        if isinstance(item, PictureItem):
            name = save_image(item)
            if name:
                blocks.append({"type": "figure", "text": "", "asset": name, "page": page(item)})
            continue
        if isinstance(item, TableItem):
            text = table_markdown(item)
            if text:
                blocks.append({"type": "table", "text": text, "page": page(item)})
            continue
        if not isinstance(item, TextItem):
            continue
        text = " ".join(item.text.split()) if not isinstance(item, (CodeItem, FormulaItem)) else item.text.strip()
        label = item.label
        if label in (DocItemLabel.PAGE_HEADER, DocItemLabel.PAGE_FOOTER):
            continue
        if isinstance(item, FormulaItem):
            if text:
                blocks.append({"type": "formula", "text": text, "page": page(item)})
            else:
                name = save_image(item)
                if name:
                    blocks.append({"type": "figure", "text": "", "asset": name, "page": page(item)})
            continue
        if not text:
            continue
        if isinstance(item, CodeItem):
            blocks.append({"type": "code", "text": text, "page": page(item)})
        elif isinstance(item, SectionHeaderItem) or label == DocItemLabel.TITLE:
            in_references = bool(REFERENCES.match(text))
            blocks.append({"type": "heading", "text": text, "level": heading_level(text, not seen_heading or label == DocItemLabel.TITLE), "page": page(item)})
            seen_heading = True
        elif label == DocItemLabel.CAPTION:
            blocks.append({"type": "caption", "text": text, "page": page(item)})
        elif label == DocItemLabel.FOOTNOTE:
            blocks.append({"type": "footnote", "text": text, "page": page(item)})
        elif in_references:
            blocks.append({"type": "reference", "text": text, "page": page(item)})
        elif isinstance(item, ListItem):
            marker = (item.marker or "").strip()
            blocks.append({"type": "list", "text": text, "marker": marker if marker not in ("", "-", "·", "•") else "•", "page": page(item)})
        else:
            blocks.append({"type": "paragraph", "text": text, "page": page(item)})
    return blocks


def main():
    source, asset_dir = sys.argv[1], sys.argv[2]
    # Keep conversion progress and model logging away from the JSON protocol.
    with contextlib.redirect_stdout(sys.stderr):
        document = convert(source, ocr=False)
        # A scan has no text layer: recognize it instead of returning an empty paper.
        if sum(len(item.text) for item, _ in document.iterate_items() if hasattr(item, "text")) < 200:
            document = convert(source, ocr=True)
        blocks = blocks_from(document, asset_dir)
        page_count = len(document.pages)
    print(json.dumps({"pageCount": page_count, "blocks": blocks}, ensure_ascii=False))


if __name__ == "__main__":
    main()
