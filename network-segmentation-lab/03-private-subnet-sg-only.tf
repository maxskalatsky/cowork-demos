# Private subnet added to the same VPC as 02's corrected public subnet
# (aws_vpc.corrected). No route to the internet gateway at all — its route
# table only carries the implicit VPC-local route, so there's no path in from
# the internet at the routing layer, before security groups even get a say.
#
# Its security group has exactly one rule: ingress from the public subnet's
# security group (aws_security_group.web_only), referenced by ID. No
# cidr_blocks anywhere — not in this ingress rule, and no egress block at all,
# which for the aws_security_group resource means zero egress rules (Terraform
# treats ingress/egress as exhaustive; omitting a direction does not fall back
# to AWS's own all-outbound default). Nothing in this resource is reachable
# from, or can reach, the internet directly.

resource "aws_subnet" "private" {
  vpc_id                  = aws_vpc.corrected.id
  cidr_block              = "10.1.2.0/24"
  map_public_ip_on_launch = false

  tags = {
    Name    = "network-segmentation-lab-private-subnet"
    Project = "network-segmentation-lab"
  }
}

resource "aws_route_table" "private" {
  vpc_id = aws_vpc.corrected.id

  tags = {
    Name    = "network-segmentation-lab-private-rt"
    Project = "network-segmentation-lab"
  }
}

resource "aws_route_table_association" "private" {
  subnet_id      = aws_subnet.private.id
  route_table_id = aws_route_table.private.id
}

resource "aws_security_group" "private_only" {
  name        = "network-segmentation-lab-private-only"
  description = "Private tier: reachable only from the public subnet's security group, no CIDR block anywhere"
  vpc_id      = aws_vpc.corrected.id

  ingress {
    description     = "Postgres, from the public web security group only - no CIDR block"
    from_port       = 5432
    to_port         = 5432
    protocol        = "tcp"
    security_groups = [aws_security_group.web_only.id]
  }

  tags = {
    Name    = "network-segmentation-lab-private-only"
    Project = "network-segmentation-lab"
  }
}
