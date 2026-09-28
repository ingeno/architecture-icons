#!/usr/bin/env node
// Summarize a CloudFormation template (for CDK: the output of `cdk synth`, cdk.out/*.template.json)
// into a draft of the pivot spec: main resources with suggested icons, subnet placement and
// relationships found through Ref/GetAtt and IAM policies. Claude reviews and simplifies the draft.
//
//   node cfn_inventory.mjs cdk.out/MyStack.template.json [more templates...] > draft.json

import fs from "node:fs";

const TYPE_ICON = {
  "AWS::Lambda::Function": "svc:aws-lambda",
  "AWS::ECS::Service": "svc:aws-fargate",
  "AWS::ECS::Cluster": "svc:amazon-elastic-container-service",
  "AWS::EKS::Cluster": "svc:amazon-elastic-kubernetes-service",
  "AWS::EC2::Instance": "svc:amazon-ec2",
  "AWS::AutoScaling::AutoScalingGroup": "svc:amazon-ec2-auto-scaling",
  "AWS::ElasticLoadBalancingV2::LoadBalancer": "res:elastic-load-balancing-application-load-balancer",
  "AWS::ApiGateway::RestApi": "svc:amazon-api-gateway",
  "AWS::ApiGatewayV2::Api": "svc:amazon-api-gateway",
  "AWS::AppSync::GraphQLApi": "svc:aws-appsync",
  "AWS::CloudFront::Distribution": "svc:amazon-cloudfront",
  "AWS::S3::Bucket": "svc:amazon-simple-storage-service",
  "AWS::DynamoDB::Table": "svc:amazon-dynamodb",
  "AWS::DynamoDB::GlobalTable": "svc:amazon-dynamodb",
  "AWS::RDS::DBInstance": "svc:amazon-rds",
  "AWS::RDS::DBCluster": "svc:amazon-aurora",
  "AWS::ElastiCache::ReplicationGroup": "svc:amazon-elasticache",
  "AWS::ElastiCache::CacheCluster": "svc:amazon-elasticache",
  "AWS::OpenSearchService::Domain": "svc:amazon-opensearch-service",
  "AWS::SQS::Queue": "svc:amazon-simple-queue-service",
  "AWS::SNS::Topic": "svc:amazon-simple-notification-service",
  "AWS::Events::EventBus": "svc:amazon-eventbridge",
  "AWS::Events::Rule": "res:amazon-eventbridge-rule",
  "AWS::StepFunctions::StateMachine": "svc:aws-step-functions",
  "AWS::Kinesis::Stream": "svc:amazon-kinesis-data-streams",
  "AWS::KinesisFirehose::DeliveryStream": "svc:amazon-kinesis-data-firehose",
  "AWS::MSK::Cluster": "svc:amazon-managed-streaming-for-apache-kafka",
  "AWS::Cognito::UserPool": "svc:amazon-cognito",
  "AWS::SecretsManager::Secret": "svc:aws-secrets-manager",
  "AWS::KMS::Key": "svc:aws-key-management-service",
  "AWS::WAFv2::WebACL": "svc:aws-waf",
  "AWS::Route53::HostedZone": "svc:amazon-route-53",
  "AWS::EC2::NatGateway": "res:amazon-vpc-nat-gateway",
  "AWS::EC2::InternetGateway": "res:amazon-vpc-internet-gateway",
  "AWS::EC2::VPCEndpoint": "res:amazon-vpc-endpoints",
  "AWS::ECR::Repository": "svc:amazon-elastic-container-registry",
  "AWS::IoT::TopicRule": "res:aws-iot-rule",
  "AWS::IoTSiteWise::AssetModel": "svc:aws-iot-sitewise",
  "AWS::Timestream::Database": "svc:amazon-timestream",
  "AWS::Glue::Job": "svc:aws-glue",
  "AWS::Glue::Crawler": "res:aws-glue-crawler",
  "AWS::Athena::WorkGroup": "svc:amazon-athena",
  "AWS::Redshift::Cluster": "svc:amazon-redshift",
  "AWS::SageMaker::Endpoint": "svc:amazon-sagemaker",
  "AWS::Bedrock::Agent": "svc:amazon-bedrock",
  "AWS::Bedrock::KnowledgeBase": "svc:amazon-bedrock",
  "AWS::CloudWatch::Alarm": "svc:amazon-cloudwatch",
  "AWS::Backup::BackupPlan": "svc:aws-backup",
  "AWS::EFS::FileSystem": "svc:amazon-efs",
  "AWS::Transfer::Server": "svc:aws-transfer-family",
  "AWS::CodePipeline::Pipeline": "svc:aws-codepipeline",
};

function refsIn(obj, acc = new Set()) {
  if (Array.isArray(obj)) obj.forEach((x) => refsIn(x, acc));
  else if (obj && typeof obj === "object") {
    for (const [k, v] of Object.entries(obj)) {
      if (k === "Ref" && typeof v === "string") acc.add(v);
      else if (k === "Fn::GetAtt") acc.add(Array.isArray(v) ? v[0] : String(v).split(".")[0]);
      else if (k === "Fn::Sub" && typeof (Array.isArray(v) ? v[0] : v) === "string")
        for (const m of String(Array.isArray(v) ? v[0] : v).matchAll(/\$\{([A-Za-z0-9]+)(?:\.[^}]*)?\}/g)) acc.add(m[1]);
      refsIn(v, acc);
    }
  }
  return acc;
}

const R = {};
for (const f of process.argv.slice(2)) {
  const t = JSON.parse(fs.readFileSync(f, "utf8"));
  Object.assign(R, t.Resources || {});
}

const cdkPath = (id) => R[id]?.Metadata?.["aws:cdk:path"] || id;
const nice = (id) => cdkPath(id).split("/").filter((s) => !/^(Resource|Default)$/.test(s)).slice(1).join("/") || id;

// subnets: public/private from CDK tags or MapPublicIpOnLaunch
const subnetKind = {};
for (const [id, r] of Object.entries(R)) {
  if (r.Type !== "AWS::EC2::Subnet") continue;
  const tag = (r.Properties?.Tags || []).find((t) => t.Key === "aws-cdk:subnet-type")?.Value;
  subnetKind[id] = (tag || (r.Properties?.MapPublicIpOnLaunch ? "Public" : "Private")).toLowerCase();
}
const placement = (r) => {
  const subs = [...refsIn(r.Properties || {})].filter((x) => subnetKind[x]);
  const kinds = [...new Set(subs.map((s) => subnetKind[s]))];
  return kinds.length ? kinds : null;
};

// main resources
const main = Object.entries(R).filter(([, r]) => TYPE_ICON[r.Type]);
const mainIds = new Set(main.map(([id]) => id));

// roles -> resources their policies point at
const roleTargets = {};
for (const [id, r] of Object.entries(R)) {
  if (r.Type !== "AWS::IAM::Policy") continue;
  const targets = [...refsIn(r.Properties?.PolicyDocument || {})].filter((x) => mainIds.has(x));
  for (const role of refsIn(r.Properties?.Roles || [])) (roleTargets[role] ||= new Set()) && targets.forEach((t) => roleTargets[role].add(t));
}

const edges = [];
for (const [id, r] of main) {
  const direct = [...refsIn(r.Properties || {})];
  const targets = new Set(direct.filter((x) => mainIds.has(x) && x !== id));
  for (const x of direct) if (roleTargets[x]) roleTargets[x].forEach((t) => t !== id && targets.add(t));
  // ECS service -> its task definition's role
  if (r.Type === "AWS::ECS::Service") {
    const td = direct.find((x) => R[x]?.Type === "AWS::ECS::TaskDefinition");
    if (td) for (const x of refsIn(R[td].Properties || {})) if (roleTargets[x]) roleTargets[x].forEach((t) => targets.add(t));
  }
  for (const t of targets) edges.push({ from: id, to: t, via: direct.includes(t) ? "reference" : "iam-policy" });
}

// event sources (Lambda triggers) point the other way: source -> function
for (const [, r] of Object.entries(R)) {
  if (r.Type !== "AWS::Lambda::EventSourceMapping") continue;
  const refs = [...refsIn(r.Properties || {})].filter((x) => mainIds.has(x));
  const fn = refs.find((x) => R[x].Type === "AWS::Lambda::Function");
  refs.filter((x) => x !== fn).forEach((src) => fn && edges.push({ from: src, to: fn, via: "event-source" }));
}

const out = {
  note: "Draft from CloudFormation. Merge duplicates, drop plumbing, name nodes by role, check edge directions (IAM edges mean 'can access', not always data flow).",
  subnets: Object.values(subnetKind).reduce((a, k) => ((a[k] = (a[k] || 0) + 1), a), {}),
  nodes: main.map(([id, r]) => ({ id, type: r.Type, icon: TYPE_ICON[r.Type], path: nice(id), subnet: placement(r) })),
  edges,
  unmapped_types: Object.entries(Object.values(R).reduce((a, r) => (TYPE_ICON[r.Type] ? a : ((a[r.Type] = (a[r.Type] || 0) + 1), a)), {}))
    .sort((a, b) => b[1] - a[1]).map(([t, n]) => `${t} x${n}`),
};
console.log(JSON.stringify(out, null, 1));
