#!/usr/bin/env python3
"""Build catalog.json (and optionally the icons/ tree) for aws-diagram-miro.

Sources
  --aws-source DIR      An unzipped official AWS Architecture Icons package
                        (https://aws.amazon.com/architecture/icons/) or the
                        icons/ folder of the npm package "aws-icons".
  --simple-icons DIR    The root of the npm package "simple-icons" (optional).

Modes
  default               Copy normalized SVGs into OUT/icons/ and write
                        OUT/catalog.json with paths relative to icons/.
  --link-only           Do not copy. Paths in the catalog stay relative to
                        --aws-source (useful to test against a CDN mirror).

Usage
  python3 scripts/build_catalog.py --aws-source ~/Downloads/Icon-package \
      --simple-icons node_modules/simple-icons --out . --aws-release 2026-07-31
"""
import argparse, json, os, re, shutil, sys

SIZE_PREF = {"48": 0, "64": 1, "32": 2, "16": 3}

# Short names people actually say -> substring of the official name (case-insensitive).
# The first catalog entry whose name contains the target wins (services before resources).
ALIASES = {
    "s3": "Simple Storage Service", "sqs": "Simple Queue Service", "sns": "Simple Notification Service",
    "ses": "Simple Email Service", "ec2": "Amazon EC2", "ecs": "Elastic Container Service",
    "eks": "Elastic Kubernetes Service", "ecr": "Elastic Container Registry", "rds": "Amazon RDS",
    "elb": "Elastic Load Balancing", "load balancer": "Elastic Load Balancing",
    "alb": "Application Load Balancer", "nlb": "Network Load Balancer",
    "api gateway": "API Gateway", "apigw": "API Gateway", "cloudfront": "CloudFront",
    "dynamodb": "DynamoDB", "kinesis": "Kinesis Data Streams", "firehose": "Data Firehose",
    "msk": "Managed Streaming for Apache Kafka", "kafka": "Managed Streaming for Apache Kafka",
    "iam": "Identity and Access Management", "kms": "Key Management Service", "cognito": "Cognito",
    "route 53": "Route 53", "route53": "Route 53", "waf": "AWS WAF", "vpc": "Virtual Private Cloud",
    "internet gateway": "Internet Gateway", "igw": "Internet Gateway", "nat gateway": "NAT Gateway",
    "nat": "NAT Gateway", "efs": "Amazon EFS", "ebs": "Elastic Block Store", "glue": "AWS Glue",
    "athena": "Athena", "redshift": "Redshift", "quicksight": "Quick", "sagemaker": "Amazon SageMaker",
    "bedrock": "Amazon Bedrock", "agentcore": "Bedrock AgentCore", "step functions": "Step Functions",
    "sfn": "Step Functions", "eventbridge": "EventBridge", "cloudwatch": "CloudWatch",
    "cloudtrail": "CloudTrail", "secrets manager": "Secrets Manager", "parameter store": "Parameter Store",
    "ssm": "Systems Manager", "codepipeline": "CodePipeline", "codebuild": "CodeBuild",
    "lambda": "AWS Lambda", "fargate": "Fargate", "greengrass": "IoT Greengrass", "iot core": "IoT Core",
    "sitewise": "IoT SiteWise", "timestream": "Timestream", "opensearch": "OpenSearch Service",
    "elasticache": "ElastiCache", "aurora": "Amazon Aurora", "documentdb": "DocumentDB",
    "textract": "Textract", "rekognition": "Rekognition", "transcribe": "Transcribe",
    "comprehend": "Amazon Comprehend", "lex": "Amazon Lex", "polly": "Polly", "amplify": "AWS Amplify",
    "appsync": "AppSync", "direct connect": "Direct Connect", "site-to-site vpn": "Site to Site VPN",
    "vpn": "Site to Site VPN", "client vpn": "Client VPN", "transit gateway": "Transit Gateway",
    "privatelink": "PrivateLink", "shield": "AWS Shield", "guardduty": "GuardDuty", "backup": "AWS Backup",
    "dms": "Database Migration Service", "datasync": "DataSync", "transfer family": "Transfer Family",
    "cdk": "Cloud Development Kit", "cloudformation": "CloudFormation", "sso": "IAM Identity Center",
    "identity center": "IAM Identity Center", "acm": "Certificate Manager", "mq": "Amazon MQ",
    "neptune": "Neptune", "memorydb": "MemoryDB", "q": "Amazon Q", "nova": "Amazon Nova",
    "user": "User", "users": "Users", "client": "Client", "mobile": "Mobile client",
    "server": "Traditional server", "on-prem server": "Traditional server", "servers": "Servers", "database": "Database", "office": "Office building", "git": "Git Repository", "email": "Email", "firewall": "Firewall", "logs": "Logs", "metrics": "Metrics", "document": "Document", "factory": "Factory", "plc": "PLC",
    "industrial pc": "Industrial PC", "sensor": "IoT Sensor", "camera": "Camera",
    "internet": "Internet", "corporate data center": "Corporate data center",
}

# Official names that are too long for a 150 px label -> the short form AWS itself uses in diagrams.
SHORT_LABELS = {
    "Amazon Simple Storage Service": "Amazon S3", "Amazon Simple Queue Service": "Amazon SQS",
    "Amazon Simple Notification Service": "Amazon SNS", "Amazon Simple Email Service": "Amazon SES",
    "Amazon Elastic Container Service": "Amazon ECS", "Amazon Elastic Kubernetes Service": "Amazon EKS",
    "Amazon Elastic Container Registry": "Amazon ECR", "Amazon Elastic Block Store": "Amazon EBS",
    "Amazon Virtual Private Cloud": "Amazon VPC", "AWS Identity and Access Management": "AWS IAM",
    "AWS Key Management Service": "AWS KMS", "Amazon Managed Streaming for Apache Kafka": "Amazon MSK",
    "Amazon Simple Storage Service Glacier": "Amazon S3 Glacier", "AWS Database Migration Service": "AWS DMS",
    "Amazon Managed Workflows for Apache Airflow": "Amazon MWAA",
    "Amazon Managed Service for Apache Flink": "Amazon Managed Flink",
    "AWS Cloud Development Kit": "AWS CDK", "Elastic Load Balancing": "Elastic Load Balancing",
}

GROUP_KEYS = {
    "aws cloud logo": "aws-cloud-logo", "aws cloud": "aws-cloud", "aws account": "aws-account",
    "region": "region", "virtual private cloud vpc": "vpc", "public subnet": "public-subnet",
    "private subnet": "private-subnet", "auto scaling group": "auto-scaling-group",
    "corporate data center": "corporate-data-center", "server contents": "server-contents",
    "ec2 instance contents": "ec2-instance-contents", "spot fleet": "spot-fleet",
    "aws iot greengrass deployment": "greengrass-deployment",
}


def slug(s):
    return re.sub(r"[^a-z0-9]+", "-", s.lower()).strip("-")


def human(s):
    return re.sub(r"\s+", " ", s.replace("-", " ")).strip()


def parse(title, relpath):
    """Return (kind, name, category, size, dark) or None."""
    dark = title.lower().endswith("_dark") or "/dark/" in relpath.lower()
    t = re.sub(r"_(dark|light)$", "", title, flags=re.I)
    m = re.search(r"Icon-Architecture-Group/(\d+)/(.+?)_(\d+)$", t)
    if m:
        return "grp", human(m.group(2)), None, m.group(3), dark, human(m.group(2))
    m = re.search(r"Icon-Architecture-Category/(\d+)/(.+?)_(\d+)$", t)
    if m:
        return "cat", human(m.group(2)), None, m.group(3), dark, human(m.group(2))
    m = re.search(r"Arch_(.+?)_(\d+)$", t)
    if m:
        cat = None
        c = re.search(r"Arch_([A-Za-z-]+)/", relpath)  # official zip folder, e.g. Arch_Compute/
        if c:
            cat = human(c.group(1))
        return "svc", human(m.group(1)), cat, m.group(2), dark, human(m.group(1))
    m = re.search(r"Icon-Resource/([^/]+)/Res_(.+?)_(\d+)$", t) or re.search(r"Res_(.+?)_(\d+)$", t)
    if m:
        if m.lastindex == 3:
            cat, body, size = human(m.group(1)), m.group(2), m.group(3)
        else:
            cat, body, size = None, m.group(1), m.group(2)
        parts = body.split("_")
        name = human(" ".join(parts)) if len(parts) > 1 else human(body)
        label = human(" ".join(parts[1:])) if len(parts) > 1 else name
        return "res", name, cat, size, dark, label
    return None


def title_of(path):
    with open(path, "r", encoding="utf-8", errors="ignore") as f:
        head = f.read(4000)
    m = re.search(r"<title>([^<]+)</title>", head)
    if m:
        return m.group(1).strip()
    # Official zip SVGs may lack <title>; fall back to the file name.
    return os.path.splitext(os.path.basename(path))[0]


def build(args):
    src = os.path.abspath(args.aws_source)
    best = {}
    for root, _, files in os.walk(src):
        for fn in files:
            if not fn.lower().endswith(".svg"):
                continue
            p = os.path.join(root, fn)
            rel = os.path.relpath(p, src)
            info = parse(title_of(p), rel)
            if not info:
                continue
            kind, name, cat, size, dark, label = info
            if kind == "grp":
                key = GROUP_KEYS.get(name.lower())
                if not key:
                    continue
                key = key + ("-dark" if dark else "")
            else:
                if dark:
                    continue
                key = slug(name)
            cid = f"{kind}:{key}"
            rank = SIZE_PREF.get(size, 9)
            if cid not in best or rank < best[cid]["_rank"]:
                best[cid] = {"id": cid, "kind": kind, "name": name, "label": label, "category": cat,
                             "_src": p, "_rel": rel, "_rank": rank}

    entries = sorted(best.values(), key=lambda e: ({"svc": 0, "res": 1, "grp": 2, "cat": 3}[e["kind"]], e["name"]))
    out = os.path.abspath(args.out)
    for e in entries:
        if args.link_only:
            e["file"] = e["_rel"].replace(os.sep, "/")
        else:
            sub = {"svc": "service", "res": "resource", "grp": "group", "cat": "category"}[e["kind"]]
            rel = f"aws/{sub}/{e['id'].split(':', 1)[1]}.svg"
            dst = os.path.join(out, "icons", rel)
            os.makedirs(os.path.dirname(dst), exist_ok=True)
            shutil.copyfile(e["_src"], dst)
            e["file"] = rel
        e["label"] = SHORT_LABELS.get(e["name"], e["label"])
        base = re.sub(r"^(Amazon|AWS)\s+", "", e["name"])
        e["aliases"] = sorted({a for a in {e["name"].lower(), base.lower()} if a})

    # Attach short aliases to the first matching entry (services win over resources).
    for alias, target in ALIASES.items():
        t = target.lower()
        hit = next((e for e in entries if e["kind"] in ("svc", "res") and e["name"].lower() == t), None) \
            or next((e for e in entries if e["kind"] in ("svc", "res") and t in e["name"].lower()), None)
        if hit and alias not in hit["aliases"]:
            hit["aliases"].append(alias)

    logos = []
    if args.simple_icons:
        si = os.path.abspath(args.simple_icons)
        data = json.load(open(os.path.join(si, "data", "simple-icons.json")))
        for d in data:
            s = d.get("slug") or slug(d["title"])
            p = os.path.join(si, "icons", s + ".svg")
            if not os.path.exists(p):
                continue
            svg = open(p, encoding="utf-8").read()
            if args.link_only:
                file = f"icons/{s}.svg"
            else:
                svg = svg.replace("<path ", f'<path fill="#{d["hex"]}" ', 1)
                file = f"logos/{s}.svg"
                dst = os.path.join(out, "icons", file)
                os.makedirs(os.path.dirname(dst), exist_ok=True)
                open(dst, "w", encoding="utf-8").write(svg)
            aka = [a.lower() for a in (d.get("aliases", {}) or {}).get("aka", [])]
            logos.append({"id": f"logo:{s}", "kind": "logo", "name": d["title"], "label": d["title"], "hex": d["hex"],
                          "file": file, "aliases": sorted({d["title"].lower(), s, *aka})})
        # Hand-added logos (icons/logos-custom/*.svg) win over Simple Icons.
    custom_dir = os.path.join(out, "icons", "logos-custom")
    if os.path.isdir(custom_dir):
        meta_path = os.path.join(custom_dir, "logos-custom.json")
        meta = json.load(open(meta_path)) if os.path.exists(meta_path) else {}
        for fn in sorted(os.listdir(custom_dir)):
            if fn.endswith(".svg"):
                s = fn[:-4]
                m = meta.get(s, {})
                logos = [l for l in logos if l["id"] != f"logo:{s}"]
                logos.append({"id": f"logo:{s}", "kind": "logo", "name": m.get("name", human(s)), "label": m.get("name", human(s)),
                              "file": f"logos-custom/{fn}",
                              "aliases": sorted({s, m.get("name", human(s)).lower(), *[a.lower() for a in m.get("aliases", [])]})})

    for e in entries:
        for k in ("_src", "_rel", "_rank"):
            e.pop(k, None)
    catalog = {
        "schema": 1,
        "aws_release": args.aws_release,
        "simple_icons_version": args.simple_icons_version,
        "counts": {k: sum(1 for e in entries if e["kind"] == k) for k in ("svc", "res", "grp", "cat")} | {"logo": len(logos)},
        "icons": entries + logos,
    }
    path = os.path.join(out, args.catalog_name)
    json.dump(catalog, open(path, "w"), indent=1, ensure_ascii=False)
    print(json.dumps(catalog["counts"]), "->", path)


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--aws-source", required=True)
    ap.add_argument("--simple-icons")
    ap.add_argument("--out", default=".")
    ap.add_argument("--link-only", action="store_true")
    ap.add_argument("--aws-release", default="unknown")
    ap.add_argument("--simple-icons-version", default="unknown")
    ap.add_argument("--catalog-name", default="catalog.json")
    build(ap.parse_args())
