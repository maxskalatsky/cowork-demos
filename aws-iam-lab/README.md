# AWS IAM least-privilege lab

Hands-on exercise: start from an over-broad policy, then narrow it down.

## 01 — over-broad EC2 full access

`01-overbroad-ec2-full-access.json` grants `ec2:*` on `Resource: "*"` — every EC2
action (including `TerminateInstances`, `DeleteSecurityGroup`, `ModifyInstanceAttribute`,
`ResetInstancePassword`, etc.) on every resource in the account, with no conditions.

This is what "full access" looks like in practice:
- No action-level scoping — read actions (`Describe*`) and destructive actions
  (`Terminate*`, `Delete*`) get the same trust.
- No resource-level scoping — applies to instances, AMIs, security groups, volumes,
  etc. across the whole account, not just the ones this service account should touch.
- No conditions — no tag-based restriction, no VPC/region restriction, no MFA requirement.

Next step in the lab: pick one real task the service account needs (e.g. "start/stop
instances tagged `Team=X`" or "describe instances only"), then rewrite the policy to
grant only that.
