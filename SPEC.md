# Pivot spec (format pivot)

Every input (conversation, document, CDK/CloudFormation, sketch, AWS reference architecture) is first translated into this JSON. The engine (`scripts/adm.mjs render`) turns it into a Miro frame, and stores the JSON in a card under the frame so the next version can start from it. Keep ids short, lowercase, stable across versions.

```json
{
  "title": "Sentinelle platform",
  "version": 1,
  "change": "initial",
  "direction": "RIGHT",
  "numbered": false,
  "legendTitle": "Flow",
  "groups": [
    {"id": "cloud",  "type": "aws-cloud",      "label": "AWS Cloud"},
    {"id": "region", "type": "region",         "label": "ca-central-1", "parent": "cloud"},
    {"id": "vpc",    "type": "vpc",            "label": "VPC",          "parent": "region"},
    {"id": "pub",    "type": "public-subnet",  "label": "Public subnet","parent": "vpc"}
  ],
  "nodes": [
    {"id": "alb", "icon": "alb", "parent": "pub"},
    {"id": "api", "icon": "fargate", "label": "API service", "parent": "priv", "status": "new"},
    {"id": "erp", "icon": "generic", "title": "ERP (SAP B1)"}
  ],
  "edges": [
    {"from": "alb", "to": "api", "label": "HTTPS", "step": 1},
    {"from": "ci", "to": "api", "label": "deploy", "style": "dashed"}
  ],
  "steps": [
    {"n": 1, "text": "The load balancer forwards API calls to the Fargate service."}
  ]
}
```

## Fields

| Field | Meaning |
|---|---|
| `title` | Diagram name. The frame is titled `v{version} · {title}` (plus `· {change}` when set). |
| `version`, `change` | Version number and a short description of what changed in this version. |
| `direction` | Main flow direction for the layout: `RIGHT` (default) or `DOWN`. A group can override it with its own `direction`. |
| `numbered` | `true` draws a numbered badge next to the source of every edge that has a `step`, plus a legend built from `steps`. Default `false`. |
| `groups[]` | Nested containers. `type` is one of the AWS group types below. `parent` nests it in another group. |
| `nodes[]` | One icon each. `icon` is a catalog id (`svc:aws-lambda`), an alias (`lambda`, `s3`, `nat gateway`, `snowflake`) or `generic` (plain box). `title` overrides the service name shown under the icon. `label` is the role line under it. `parent` is a group id. `status` is `new` or `changed` to show a NEW/CHANGED marker. |
| `edges[]` | `from`/`to` are node or group ids. Optional `label`, `step` (number), `style: "dashed"`, `bidirectional: true`, `layout: true`. A solid edge means "A sends to B". A dashed edge is a dependency and reads "X uses Y" (DNS, WAF, secrets, JWKS, NAT egress, bastion admin). Dashed edges do not drive the layout unless `layout: true`. |
| `steps[]` | Legend lines for numbered diagrams: `{n, text}`. |

## Group types (AWS conventions)

| type | Border | Icon |
|---|---|---|
| `aws-cloud` | solid dark `#232F3E` | AWS Cloud logo |
| `aws-account` | solid pink `#E7157B` | AWS Account |
| `region` | dashed teal `#00A4A6` | Region |
| `availability-zone` | dashed teal `#00A4A6` | none |
| `vpc` | solid purple `#8C4FFF` | VPC |
| `public-subnet` | solid green `#7AA116`, light green fill | Public subnet |
| `private-subnet` | solid teal `#00A4A6`, light teal fill | Private subnet |
| `security-group` | solid red `#DD344C` | none |
| `auto-scaling-group` | dashed orange `#ED7100` | Auto Scaling group |
| `corporate-data-center` | solid gray `#7D8998` | Corporate data center (use for plants and on-prem sites) |
| `server-contents` | solid gray `#7D8998` | Server contents |
| `ec2-instance-contents` | solid orange `#ED7100` | EC2 instance contents |
| `spot-fleet` | solid orange `#ED7100` | Spot Fleet |
| `greengrass-deployment` | solid green `#7AA116` | IoT Greengrass deployment |
| `generic` | dashed gray `#7D8998` | none (third-party SaaS, another cloud, a team boundary) |
| `internet` | solid dark `#232F3E`, bold label | Internet (outer box holding people, client apps, client sites, third parties and AWS Cloud) |
| `client-lane` | dotted dark `#232F3E`, no label | none (clients that behave the same way, e.g. web app + mobile app) |
| `context` | dashed red `#FF6464`, bold red label | none (context for the client, e.g. "Monitoring and alerts") |
| `foundation` | solid gray `#7D8998`, light gray fill | none (account baseline: CloudTrail, CloudWatch, Security Hub, GuardDuty, only when they exist) |

## Modelling rules

1. Nest only what is really nested: AWS Cloud > Account (optional) > Region > VPC > AZ (optional) > Subnet.
2. Regional services that do not live in a VPC (S3, DynamoDB, SQS, Lambda outside a VPC, Bedrock) go in the Region group, not in the VPC.
3. Global or edge services (CloudFront, Route 53, IAM, WAF on CloudFront) go in the AWS Cloud group outside the Region.
4. People, devices, plants and third-party tools go outside AWS Cloud. On-prem things go in a `corporate-data-center` group.
5. Show two AZs only when high availability is the point of the diagram. Otherwise one subnet of each kind is enough.
6. Twelve to twenty-five nodes is the sweet spot. Beyond thirty, split into an overview diagram and detail diagrams.
7. One edge per real relationship, in the direction the request or data flows.
8. Never box a single icon in a `client-lane`. The engine drops such a lane and keeps the item.
9. When every member of a `client-lane` has the same edge (same other end, label and style), the engine draws one edge from or to the lane instead. Edges that only some members have stay on those members. `render` lists these merges under `normalized`, and the spec card stores the normalized spec.
10. Keep detail sober: leave out CI/CD, container registries and push providers unless asked.
11. After ELK, `scripts/opt.mjs` models the elbowed route Miro draws for every connector and scores the diagram for a reader: crossings, lines through icons or labels, hidden text (a connector caption, placed by Miro at the middle of the path, touching a box border, a line or an icon; a line over a group title), lines drawn on top of each other, bends, flow arrows pointing back left, near-misses in alignment. It then moves icons and boxes inside their parent group and picks connector sides to lower that score (simulated annealing, several seeded runs, deterministic). `render` reports the score before and after under `quality`; `--preview file.svg` writes a local picture of the planned routes.
12. An arrow leaving or reaching the bottom of an icon attaches to its label, so it never hides the text.
13. `render` lists `group_pairs` (icon + label, group icon + group title). `scripts/rest.mjs plan` turns the rendered SVG into Miro REST API v2 calls (frame, bulk items, spec card, connectors, groups) and groups every pair; `rest.mjs ids` maps the created items back by position, `rest.mjs fill` resolves the ids in each step, and `rest.mjs tosvg` rebuilds a board read for `adm.mjs readback`.
14. Captions can sit anywhere along a connector with the REST API. The optimizer slides each caption (20 % to 80 % of the path) until no text is hidden, as close to the middle as possible; `render` writes the position as `data-caption-position`.
15. Icons in the same box that are within 100 px of a common row or column are lined up (48 px across boxes). Nested boxes keep 28 px of air between their borders.
