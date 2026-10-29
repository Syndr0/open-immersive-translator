# Docling worker for papers

The built-in parser reads a PDF's text layer. This worker runs [Docling](https://github.com/docling-project/docling) layout analysis instead, so academic papers keep:

- figures, cropped from the page as PNG images;
- display formulas as LaTeX (rendered with KaTeX), or as images when they cannot be read;
- tables as cell grids, translated cell by cell;
- headings, lists, captions, footnotes and one block per reference;
- OCR for scanned pages without a text layer.

It needs Python 3.10 or newer. From the repository root:

```sh
python3.12 -m venv .venv-docling
.venv-docling/bin/pip install -r workers/docling/requirements.txt
```

Then set `PARSER=docling` and `DOCLING_PYTHON=.venv-docling/bin/python` in `.env` and restart the API. The environment is about 1.5 GB; the first conversion downloads model weights. A 15-page paper takes roughly 10–30 seconds on a recent laptop.

Protocol: `parse.py INPUT.pdf ASSET_DIR` prints `{"pageCount": n, "blocks": [...]}` and writes `figure-N.png` files into `ASSET_DIR`. The API validates every block and only stores figures that a block references.

Docling code and model weights have separate license terms. See the upstream repository for supported formats, hardware and model licenses.
