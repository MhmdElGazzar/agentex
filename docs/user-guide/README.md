# AgenTeX User Guides

Step-by-step guides to read in order, with diagrams, real examples and a cheat sheet. Each
guide has its own folder: the chapters are markdown files (easy to update, and searchable on
GitHub, with `grep` and by AI assistants), next to a PDF export for reading offline or sharing.

| Guide | Folder | PDF | Read it if you… |
|-------|--------|-----|-----------------|
| **AgenTeX User Guide** | [agentex/](./agentex/README.md): 20 chapters, a glossary and a cheat sheet | [agentex-user-guide.pdf](./agentex/agentex-user-guide.pdf) | want the whole framework: install, configuration, specs, browser, mobile, API, database, UI check, knowledge base, Jira, Azure DevOps, reports, CI, git and troubleshooting. |
| **Mobile Testing User Guide** | [mobile/](./mobile/README.md): 7 short sections | [agentex-mobile-user-guide.pdf](./mobile/agentex-mobile-user-guide.pdf) | only test native Android or iOS apps and want the short path. |

```
docs/user-guide/
├── README.md                     ← this page
├── agentex/                      ← the full AgenTeX User Guide
│   ├── README.md                 ← its table of contents
│   ├── 01-what-is-agentex.md … 20-troubleshooting-and-faq.md
│   ├── glossary.md
│   ├── cheat-sheet.md
│   └── agentex-user-guide.pdf
└── mobile/                       ← the Mobile Testing User Guide
    ├── README.md                 ← its table of contents
    ├── 01-how-it-works.md … 07-troubleshooting-and-cheat-sheet.md
    └── agentex-mobile-user-guide.pdf
```

**Guide or reference page?** A guide tells you what to do, in order. The reference pages in
[`docs/`](../README.md) hold every option and detail of each feature. When you change how a
feature works, update both.

## Updating a guide

1. **Edit the markdown** chapter in the guide's folder. Keep each chapter's heading numbers
   (`## 9.4 …`), because other chapters link to them by anchor.
2. **Check the links.** Every relative link must point to an existing file.
3. **Add a changelog note** in `changelog.d/`, as for any other change.
4. **Re-export the PDF** when you want the download to match. The markdown is the source of
   truth; a PDF can lag behind until it is exported again.

## Exporting the PDFs

Any markdown-to-PDF tool works; this repository installs none. Two simple options:

- **VS Code:** install the "Markdown PDF" extension, open a chapter and run *Markdown PDF:
  Export (pdf)*. For one PDF per guide, export the chapters in order and combine them, or use
  Pandoc.
- **Pandoc** (from pandoc.org) with a PDF engine, run inside the guide's folder:

  ```
  # in docs/user-guide/agentex/
  pandoc README.md 0*.md 1*.md 20-*.md glossary.md cheat-sheet.md -o agentex-user-guide.pdf --toc

  # in docs/user-guide/mobile/
  pandoc README.md 0*.md -o agentex-mobile-user-guide.pdf
  ```

Save each PDF under the **same file name, in its guide's folder**, so every link keeps working.
Diagrams written as `mermaid` blocks render on GitHub; for the PDF, use a tool or extension
with Mermaid support, or paste a screenshot of the rendered diagram.
