# Optional Docling recognition

The basic application uses PDF.js text extraction. This adapter runs actual Docling conversion for scanned/complex PDFs; it is optional because model packages are larger and hardware requirements vary.

From the repository root:

```sh
python3 -m venv .venv-docling
.venv-docling/bin/pip install -r workers/docling/requirements.txt
```

Set `PARSER=docling` and `DOCLING_PYTHON=.venv-docling/bin/python` in `.env`, then restart the API. Initial conversion may download model weights. Source PDFs remain local to the worker, while translation follows your configured provider.

The worker exports recognized Markdown into the common block model. This first adapter does not bundle cropped images or retain page geometry, so it is a recognition/text-reflow feature rather than an original-layout writer. Math markup is protected from translation. Verify recognition on your own corpus; Docling integration is not tested by the default lightweight CI suite.

Docling code and model weights have separate license terms. See the [upstream repository](https://github.com/docling-project/docling) for installation, supported formats, hardware and model licenses.
