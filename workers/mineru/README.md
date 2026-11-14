# MinerU parser for papers and lecture notes

[MinerU](https://github.com/opendatalab/MinerU) reads PDFs with layout and formula models and returns LaTeX for **both display and inline math**, plus tables, figures with captions, footnotes and references. It is the recommended parser for math-heavy documents.

Measured on a Mac mini (M4, 16 GB), models loaded:

| Document | Pages | MinerU `standard` |
| --- | --- | --- |
| Lecture notes with ~30 equations | 9–10 | 60–75 s |
| arXiv paper, light on math | 15 | about 10 s |

Time grows with the amount of math, not the page count. The first document after starting the API waits about 15–30 s more while the models load.

## Install

Python 3.11–3.14. From the repository root:

```sh
python3.12 -m venv .venv-mineru
.venv-mineru/bin/pip install "mineru>=4.2,<5"
.venv-mineru/bin/mineru-kit models download --tier standard
```

That is about 1.6 GB of packages and 2 GB of models (in `~/.mineru`). On Apple Silicon it uses the GPU (MPS); `mineru-kit hardware detect` shows the recommended tier.

Then set in `.env` and restart the API:

```dotenv
PARSER=mineru
```

## How it runs

The API starts MinerU's own local service (`mineru-kit api-server`, bound to 127.0.0.1) when it starts, keeps its models loaded, and stops it on shutdown. Settings:

| Variable | Default | Purpose |
| --- | --- | --- |
| `MINERU_COMMAND` | `.venv-mineru/bin/mineru-kit` | The MinerU command |
| `MINERU_TIER` | `standard` | `flash`, `basic`, `standard` or `advanced` |
| `MINERU_PORT` | `8793` | Port for the service the API starts |
| `MINERU_URL` | | Use an already running MinerU service on this computer instead (loopback only) |

If MinerU is missing or fails on a file, the import falls back to Docling (when `DOCLING_PYTHON` is set), then to the built-in parser, and the document carries a note saying so. Each display formula keeps a cropped image next to its LaTeX, so an AI agent can check or repair it with the `get_formulas` / `save_formulas` MCP tools.

## Licence

MinerU uses the MinerU Open Source License: Apache 2.0 plus two conditions. A commercial licence is needed above 100 million monthly active users or USD 20 million monthly revenue, and an online service built on it must say it uses MinerU. It is installed separately and is not part of this repository.
