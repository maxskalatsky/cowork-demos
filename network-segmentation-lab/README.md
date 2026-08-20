# Network segmentation lab

Hands-on Terraform exercise: start from a flat, wide-open network, then split it
into a public area facing the street and a private area behind it. Same shape as
[`aws-iam-lab`](../aws-iam-lab) — start overbroad, narrow it down, verify with a
linter at each step.

## 01 — flat network, open to all

`01-flat-network-open-to-all/` is one VPC, one subnet, and one security group.
Both the "web" instance and the "db" instance sit in the same subnet, routed to
the internet gateway, behind the same security group that allows every port and
every protocol from `0.0.0.0/0` in both directions. This is the network
equivalent of `ec2:*` on `Resource: "*"` from the IAM lab:

- No subnet-level scoping — public and private workloads share one routed subnet.
- No security-group-level scoping — the db instance gets the exact same open
  inbound/outbound rule as the web instance, despite never needing to be reachable
  from the internet at all.
- No routing-level scoping — every subnet has a route to the internet gateway,
  so there's no path where "behind the street" is actually true.

Next step: split the flat subnet into a public tier that's supposed to face the
internet and a private tier that isn't, and give each its own routing and its own
security group instead of one blanket rule.

## 02 — public/private, segmented

`02-public-private-segmented/` splits the flat network into two subnets and two
security groups, scoped by role instead of one rule for everything:

- **Public subnet** (`10.0.1.0/24`) — has a route to the internet gateway.
  `public_web` security group allows only 80/443 inbound from `0.0.0.0/0`.
- **Private subnet** (`10.0.2.0/24`) — its route table has no `0.0.0.0/0` route
  at all, only the implicit VPC-local route. There's no path from the internet
  into this subnet at the routing layer, before security groups even get a say.
  `private_db` security group allows inbound only from `public_web`'s security
  group ID on port 5432 — no CIDR block anywhere in its ingress rules.

Verified with [Checkov](https://www.checkov.io/), a static Terraform security
linter (the Terraform-world analog of Parliament from the IAM lab):

```
checkov -d 02-public-private-segmented
```

`aws_security_group.private_db` gets **zero** `0.0.0.0/0`-ingress findings —
Checkov has rules for exactly this (`CKV_AWS_24`/`25`/`260`/`277`, flagging
SSH/RDP/HTTP/all-ports open to the internet) and none of them fire against it,
because its only ingress rule references `public_web`'s security group ID, never
a CIDR block.

`aws_security_group.public_web` *does* get flagged — `CKV_AWS_260` ("no security
groups allow ingress from 0.0.0.0:0 to port 80") — and that's expected and
correct, not a bug in the config. This is the tier meant to face the street; a
web tier that isn't reachable from the internet on 80/443 can't serve web
traffic. Same pattern as `02` in the IAM lab, where Parliament's `Resource: "*"`
finding on the read-only role was expected too: the linter is telling you what's
open, and it's your job to confirm that's the tier where "open" is the point.
The rest of the findings in this step (detailed monitoring, EBS optimization,
IMDSv2, EBS encryption, no IAM instance profile, no VPC flow logs, default SG
not locked down) are real hardening gaps, but they're generic
instance/account-level hygiene, not network segmentation — out of scope for this
lab, worth fixing before this goes anywhere real.

## 03 — private subnet gets outbound-only internet access

`03-private-nat-egress/` is `02` plus a NAT gateway sitting in the public subnet.
The private subnet's route table now sends `0.0.0.0/0` to the NAT gateway instead
of nowhere, so private instances can reach the internet outbound (OS patches,
package mirrors) — a real capability this network didn't have before.

What doesn't change: `private_db`'s ingress rule. It's still only
`public_web`'s security group ID on 5432, no CIDR block, exactly as in `02`. A
NAT gateway is one-directional by construction — it lets outbound connections
out and their return traffic back, but it cannot originate an inbound connection
from the internet the way `01`'s flat security group could. Adding it is a
scoped, additive capability, not a rollback to `01`'s "everything from
everywhere." Same shape as the IAM lab's `03` (handyman gets exactly
start/stop/reboot on tagged instances, nothing else reopens): grant the one
capability that's actually needed, verify nothing else moved.

Checkov confirms: `private_db` in `03` has the same zero `0.0.0.0/0`-ingress
result as in `02`. The only new finding versus `02` is `CKV_AWS_382` ("no
security groups allow egress from 0.0.0.0:0 to port -1") on `private_db` itself,
because its egress rule is now open to let traffic reach the NAT gateway — that's
the outbound-only capability this step adds, correctly flagged as open on the
one side it's actually open.

## Verifying it yourself

Each numbered folder is a standalone Terraform root module — its own provider
block, its own state, nothing shared between steps. From inside a folder:

```
terraform init
terraform validate
checkov -d .
```

None of these need real AWS credentials — `validate` only checks syntax and
type-correctness, and Checkov is a static analyzer that reads the `.tf` files
directly. `terraform init` does need internet access once, to download the AWS
provider plugin. `ami_id` in every `variables.tf` is a placeholder
(`ami-0000000000000000`) — replace it with a real AMI ID for your region before
running `terraform plan` or `apply` against a real account.

Setup notes (Windows, this machine): Terraform wasn't on `PATH` — installed via
`winget install --id Hashicorp.Terraform -e`. Checkov isn't a system package,
just `pip install checkov` (this machine already had a working Python 3.12 from
setting up the IAM lab's Parliament).
