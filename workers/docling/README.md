# Docling worker for papers

The built-in parser reads a PDF's text layer. This worker runs [Docling](https://github.com/docling-project/docling) layout analysis instead, so academic papers keep:

- figures, cropped from the page as PNG images;
- display formulas as images, which an AI agent then converts to LaTeX (see below);
- tables as cell grids, translated cell by cell;
- headings, lists, captions, footnotes and one block per reference;
- OCR for scanned pages without a text layer.

It needs Python 3.10 or newer. From the repository root:

```sh
python3.12 -m venv .venv-docling
.venv-docling/bin/pip install -r workers/docling/requirements.txt
```

Then set `PARSER=docling` and `DOCLING_PYTHON=.venv-docling/bin/python` in `.env` and restart the API. The environment is about 1.5 GB; the first conversion downloads model weights. A 15-page paper takes roughly 5–30 seconds on a recent laptop.

## Formulas

Docling's own formula model is slow on a laptop or Mac mini CPU: a 10-page lecture with 35 equations took several minutes, against about 6 seconds without it. By default (`DOCLING_FORMULAS=agent`) the worker skips it and keeps each display formula as a cropped image, with the PDF's own text for it as a hint. The reader shows the image until LaTeX is supplied.

To convert them, ask your coding agent (Codex, Claude Code) with the project's MCP service connected: it calls `get_formulas`, reads each image with its own model, and saves LaTeX with `save_formulas`. See [docs/agent-service.md](../../docs/agent-service.md). On a machine with a capable GPU you can set `DOCLING_FORMULAS=local` to run Docling's model during import instead; formulas it cannot read are still kept as images. Inline math in paragraphs stays as the PDF's own text in agent mode.

Protocol: `parse.py INPUT.pdf ASSET_DIR [agent|local]` prints `{"pageCount": n, "blocks": [...]}` and writes `figure-N.png` and `formula-N.png` files into `ASSET_DIR`. The API validates every block and only stores figures that a block references.

Docling code and model weights have separate license terms. See the upstream repository for supported formats, hardware and model licenses.
