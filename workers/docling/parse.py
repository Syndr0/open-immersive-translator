"""Optional real OCR/layout adapter. Input is a local PDF; stdout is one JSON object."""
import contextlib
import json
import sys


def main():
    # Keep conversion progress/model logging away from the JSON protocol.
    with contextlib.redirect_stdout(sys.stderr):
        from docling.document_converter import DocumentConverter
        result = DocumentConverter().convert(sys.argv[1])
        document = result.document
        markdown = document.export_to_markdown()
        page_count = len(document.pages)
    print(json.dumps({"markdown": markdown, "pageCount": page_count}, ensure_ascii=False))


if __name__ == "__main__":
    main()
