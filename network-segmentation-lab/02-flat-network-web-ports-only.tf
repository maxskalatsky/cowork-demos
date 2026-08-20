# Corrected version of 01-flat-network-open-to-all.tf. Same flat topology, no
# public/private split yet — only the security group changes. This file shares
# the terraform/provider blocks already declared in 01, so it only adds resources.
#
# 80 and 443 stay open to the internet — that traffic is supposed to be
# reachable from anywhere. SSH, RDP, and every other port are not in this
# security group's ingress rules at all, so nothing on them is reachable from
# outside: AWS security groups default-deny anything not explicitly allowed in.

resource "aws_vpc" "corrected" {
  cidr_block           = "10.1.0.0/16"
  enable_dns_support   = true
  enable_dns_hostnames = true

  tags = {
    Name    = "network-segmentation-lab-corrected"
    Project = "network-segmentation-lab"
  }
}

resource "aws_internet_gateway" "corrected" {
  vpc_id = aws_vpc.corrected.id

  tags = {
    Name    = "network-segmentation-lab-corrected-igw"
    Project = "network-segmentation-lab"
  }
}

resource "aws_subnet" "corrected" {
  vpc_id                  = aws_vpc.corrected.id
  cidr_block              = "10.1.1.0/24"
  map_public_ip_on_launch = true

  tags = {
    Name    = "network-segmentation-lab-corrected-subnet"
    Project = "network-segmentation-lab"
  }
}

resource "aws_route_table" "corrected" {
  vpc_id = aws_vpc.corrected.id

  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.corrected.id
  }

  tags = {
    Name    = "network-segmentation-lab-corrected-rt"
    Project = "network-segmentation-lab"
  }
}

resource "aws_route_table_association" "corrected" {
  subnet_id      = aws_subnet.corrected.id
  route_table_id = aws_route_table.corrected.id
}

# Only 80 and 443 in, from anywhere. Nothing else — no SSH, no RDP, no catch-all
# ingress rule for the rest of the port range.
resource "aws_security_group" "web_only" {
  name        = "network-segmentation-lab-web-only"
  description = "Corrected: only HTTP/HTTPS reachable from the internet, nothing else"
  vpc_id      = aws_vpc.corrected.id

  ingress {
    description = "HTTPS from anywhere"
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  ingress {
    description = "HTTP from anywhere"
    from_port   = 80
    to_port     = 80
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  egress {
    description = "All outbound"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = {
    Name    = "network-segmentation-lab-web-only"
    Project = "network-segmentation-lab"
  }
}
