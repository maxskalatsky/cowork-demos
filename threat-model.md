# Threat Model: Fabric MCP Automation Account

Scope: the automation account used by an MCP server to drive Fabric on behalf of
Terraform-managed infrastructure. This account is provisioned without delete
permission, even though the Terraform configuration it supports includes resources
that require `delete` to reconcile state (destroy, replace, taint workflows).

This document is a standalone conceptual STRIDE analysis. The account itself is not
part of this repository, and no IAM or network controls described here are currently
implemented against it — where a mitigation pattern is referenced, it is named
explicitly as a pattern demonstrated elsewhere, not a control in place for this
account.

## Spoofing

**Asset at risk:** the credential/token that lets a caller authenticate to Fabric's
MCP endpoint *as* the automation account, and — symmetrically — the endpoint identity
that the automation account trusts when it calls out to Fabric.

**Could something successfully impersonate this account?**

Spoofing here has two directions, and both are live risks for an MCP-mediated
automation identity:

1. **Something impersonates the account to Fabric.** If the account's credential
   (API key, service principal secret, OAuth token, or MCP session token) is
   long-lived, broadly held, or logged/cached anywhere in the CI pipeline, Terraform
   state backend, or MCP server process, anyone who obtains it can call Fabric as this
   account with no further checks. MCP servers commonly run as a shared process with
   access to multiple downstream credentials, which widens who can effectively "be"
   this account beyond just the automation itself. A replayed or stolen token is
   indistinguishable from a legitimate call unless the credential is short-lived and
   the caller's context (not just the token) is verified.

2. **Something impersonates Fabric to the account.** The automation account has to
   trust *some* endpoint as "Fabric." If the MCP server's routing/DNS/TLS trust for
   that endpoint isn't pinned or verified, a compromised network path or
   misconfigured MCP tool registration could redirect the account's calls to an
   attacker-controlled endpoint that mimics Fabric's API surface — harvesting whatever
   the account sends (including the credential itself, in some auth flows) and
   returning fabricated responses to Terraform.

**Does the missing delete permission change the picture?**

It cuts one way and opens another:

- It *narrows* the blast radius of case 1. A spoofed identity that only holds
  create/update/read scope can't be used to destroy Fabric resources outright, which
  is a real containment benefit even if it wasn't the intent.
- It *creates a second identity to worry about.* Terraform needs delete somewhere. If
  that gap is closed with a parallel, more-privileged identity or a manual/break-glass
  path (a human running `terraform destroy` with elevated creds, a second service
  principal scoped for delete, a console workaround), that second identity is now the
  more attractive spoofing target, and it's easy for it to be less scrutinized than
  the "official" automation account precisely because it's a workaround rather than
  a documented part of the pipeline. Any spoofing analysis of this account is
  incomplete without also covering whatever fills the delete gap.

**Existing mitigations**

None are currently implemented for this account or its Fabric MCP integration — there
is no IAM or Vault work wired up to it in this repository today.

Two unmerged branches in this repo demonstrate the general mitigation pattern that
would apply here — scoped credentials and provable authentication — without either
being applied to this account:

- `aws-iam-lab` — demonstrates narrowing a credential from broad `Resource: "*"` /
  `Action: "*"` access down to tag- and action-scoped grants (e.g., only
  `Start/Stop/RebootInstances` on resources tagged for the specific workload),
  verified with Parliament. The same shape of restriction — scope the credential to
  exactly the actions and resources the automation needs, nothing adjacent — is the
  relevant pattern for reducing what a spoofed credential could do.
- `network-segmentation-lab` — demonstrates removing implicit trust at the network
  layer: a private subnet with no internet route and a security group that only
  accepts traffic from a named peer security group, not a CIDR block, validated with
  `terraform validate` and Checkov. The same shape of restriction — the account should
  only be reachable from, and only trust traffic from, a specifically named peer
  rather than an open network path — is the relevant pattern for reducing endpoint
  spoofing risk in case 2.

Neither branch's controls are wired to the Fabric MCP automation account; they are
named here only as evidence the pattern has been worked through in this repo, not as
implemented mitigations.
