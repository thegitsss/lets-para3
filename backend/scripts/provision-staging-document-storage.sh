#!/bin/bash
set -euo pipefail
# Default: identity/schema preflight only. No template upload bucket or paid helper services.
LPC_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
LPC_PROFILE="${LPC_AWS_PROVISION_PROFILE:-lpc-staging-provisioner}"
LPC_TEMPLATE="$LPC_ROOT/outputs/document-security-20261013/staging-storage.cloudformation.json"
LPC_HASH_FILE="$LPC_ROOT/outputs/document-security-20261013/approved-template.sha256"
LPC_REGION=us-east-1
LPC_STACK=lpc-document-security-staging
LPC_MODE="${1:---preflight}"
case "$LPC_MODE" in --preflight|--create-approved) ;; *) echo 'Use --preflight or --create-approved.' >&2; exit 2;; esac
command -v aws >/dev/null || { echo 'AWS CLI v2 is required. Complete the documented browser-login setup; do not share credentials.' >&2; exit 3; }
LPC_ACTUAL_HASH="$(shasum -a 256 "$LPC_TEMPLATE" | cut -d ' ' -f 1)"
LPC_EXPECTED_HASH="$(cat "$LPC_HASH_FILE")"
[[ "$LPC_ACTUAL_HASH" == "$LPC_EXPECTED_HASH" ]] || { echo 'Reviewed template hash changed. Stop for review.' >&2; exit 4; }
LPC_ACCOUNT="$(aws sts get-caller-identity --profile "$LPC_PROFILE" --region "$LPC_REGION" --query Account --output text --no-cli-pager)"
LPC_ARN="$(aws sts get-caller-identity --profile "$LPC_PROFILE" --region "$LPC_REGION" --query Arn --output text --no-cli-pager)"
[[ "$LPC_ACCOUNT" == '096929701923' ]] || { echo 'Wrong AWS account; no changes made.' >&2; exit 5; }
[[ "$LPC_ARN" != 'arn:aws:iam::096929701923:user/paraconnect-uploader' ]] || { echo 'Production uploader is forbidden for provisioning.' >&2; exit 6; }
aws cloudformation validate-template --profile "$LPC_PROFILE" --region "$LPC_REGION" --template-body "file://$LPC_TEMPLATE" --query 'Capabilities' --output json --no-cli-pager
printf 'Preflight passed for account %s, region %s; template SHA-256 %s.\n' "$LPC_ACCOUNT" "$LPC_REGION" "$LPC_ACTUAL_HASH"
if [[ "$LPC_MODE" == '--preflight' ]]; then exit 0; fi
# User approved exactly this stack/key and bounded usage on 2026-10-13. No update-existing-stack path.
aws cloudformation create-stack --profile "$LPC_PROFILE" --region "$LPC_REGION" --stack-name "$LPC_STACK" --template-body "file://$LPC_TEMPLATE" --capabilities CAPABILITY_NAMED_IAM --tags Key=Environment,Value=staging Key=Application,Value=LPC Key=Data,Value=synthetic-only --query StackId --output text --no-cli-pager
aws cloudformation wait stack-create-complete --profile "$LPC_PROFILE" --region "$LPC_REGION" --stack-name "$LPC_STACK"
aws cloudformation describe-stacks --profile "$LPC_PROFILE" --region "$LPC_REGION" --stack-name "$LPC_STACK" --query 'Stacks[0].Outputs' --output json --no-cli-pager
# No access-key creation/printing, Render deployment, app request, email or real-data copy here.
