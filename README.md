# architecture-icons

Icons, catalog and layout engine behind the **aws-diagram-miro** Claude skill used at Ingeno to draw AWS architecture diagrams in Miro.

Miro can only place images that live at a public URL. This repo is that URL: every icon is served by jsDelivr from a pinned tag, so a diagram never breaks when AWS renames or redraws an icon.

```
https://cdn.jsdelivr.net/gh/ingeno/architecture-icons@<tag>/icons/<file>
```

## Content

| Path | What |
|---|---|
| `icons/aws/service/` | AWS Architecture Service icons (official package, 48 px artboard) |
| `icons/aws/resource/` | AWS Resource icons, including General icons (users, servers, factory, PLC, sensors) |
| `icons/aws/group/` | AWS group icons (AWS Cloud, Region, VPC, subnets...) |
| `icons/aws/category/` | AWS category icons |
| `icons/logos/` | Third-party brand logos from Simple Icons, colored with the brand color |
| `icons/logos-custom/` | Logos added by hand when Simple Icons does not have them |
| `catalog.json` | Every icon with its id, official name, short label, category and aliases |
| `SPEC.md` | The pivot spec the engine takes as input |
| `scripts/adm.mjs` | Engine: `resolve`, `render` (ELK layout to Miro SVG), `stamp`, `readback` |
| `scripts/cfn_inventory.mjs` | CloudFormation / `cdk synth` output to a draft pivot spec |
| `scripts/build_catalog.py` | Rebuilds `icons/` and `catalog.json` from a new AWS package |
| `tests/` | Smoke test specs |

## Try it

```bash
cd scripts && npm install
node adm.mjs resolve --catalog ../catalog.json "s3" "nat gateway" "snowflake"
node adm.mjs render --spec ../tests/smoke.json --catalog ../catalog.json \
  --base https://cdn.jsdelivr.net/gh/ingeno/architecture-icons@v2026.07.1/icons/ --out /tmp/smoke.svg
```

Paste the SVG with the Miro MCP tool `canvas_create_from_svg`.

## Releases

One tag per AWS icon release, plus a patch number for logos or engine fixes: `v2026.07.1`, `v2026.07.2`, `v2026.10.1`. Never move or delete a tag: live diagrams point to it.

## Licenses

AWS Architecture Icons: AWS allows customers and partners to use them to create architecture diagrams (https://aws.amazon.com/architecture/icons/). Simple Icons: CC0, brand logos remain trademarks of their owners and are used here only to show integrations. Engine code: MIT.
