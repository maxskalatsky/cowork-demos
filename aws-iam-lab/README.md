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

## 02 — read-only "maid" role (look, don't touch)

`02-readonly-ec2-maid.json` is the scoped-down version for a role that only needs to
check on things — never create, delete, or modify. It grants exactly the 269 EC2
actions that start with `Describe` or `Get`, still on `Resource: "*"`.

Why `Resource: "*"` is still there, and that's correct: almost all EC2 `Describe*`/`Get*`
actions don't support resource-level permissions in AWS's own IAM model — they only
work when the resource is `*`. That's *why* Parliament's `01` finding didn't flag most of
them: it only complains about `Resource: "*"` on actions that could have been scoped
tighter. For read-only EC2 calls, `*` isn't an oversight, it's the only option AWS gives.

How the action list was built: not by hand. `Describe`/`Get` string-matching alone risks
missing actions or catching something destructive with a misleading name, so the list
came from botocore's EC2 service model (`session.get_service_model('ec2').operation_names`,
269 of 800 total EC2 operations) filtered to names starting with `Describe`/`Get`, then a
script re-checked every action in the output actually starts with one of those two
prefixes before it shipped.

Verified two ways:
1. Parliament (`parliament --file 02-readonly-ec2-maid.json`) reports **zero**
   `RESOURCE_STAR` or unsafe-action findings. It does flag ~57 actions as "Unknown
   action" (things like `DescribeRouteServer*`, `GetCapacityManager*`, `GetIpamPolicy*`)
   — that's Parliament's bundled action database lagging behind newer AWS API additions,
   not a problem with the policy: botocore, the more current source, already knows them.
2. A script re-derives the read-only set from the same botocore model and diffs it
   against the policy's `Action` list — confirms all 269 entries start with `Describe`
   or `Get` and nothing else snuck in.

This is a read role, not a "safe" role in the compliance sense — some `Describe`/`Get`
calls (e.g. `GetConsoleOutput`, `GetPasswordData`) can expose sensitive instance data.
Least privilege for a real maid account should still scope this by resource tag or
account/VPC where the API allows it, and pair it with CloudTrail logging on the role.

## Linting with Parliament

[Parliament](https://github.com/duo-labs/parliament) is an open-source IAM policy
linter. It flags this policy's `Resource: "*"` as unnecessary and lists every one of
the ~340 EC2 actions it's applying to — see `01-overbroad-ec2-full-access.parliament.json`
for the full finding.

Setup notes (Windows, this machine):
- `python`/`python3` on PATH were 0-byte Windows Store "app execution alias" stubs, not
  a real interpreter — `winget search`/`install` (not the Microsoft Store) was needed to
  get an actual Python 3.12 install.
- A new shell is required (or refresh `$env:Path` from the registry) before `python`
  resolves, since winget updates PATH via the registry, not the current process.
- `pip install parliament` alone wasn't enough — Parliament imports `pkg_resources`,
  which recent `setuptools` (81+) removed. Fixed with `pip install "setuptools<81"`.

Run it yourself:
```
parliament --file 01-overbroad-ec2-full-access.json
```
