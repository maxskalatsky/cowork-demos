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
