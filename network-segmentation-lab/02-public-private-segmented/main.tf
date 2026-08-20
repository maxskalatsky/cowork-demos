terraform {
  required_version = ">= 1.5"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

provider "aws" {
  region = var.aws_region
}

resource "aws_vpc" "lab" {
  cidr_block           = "10.0.0.0/16"
  enable_dns_support   = true
  enable_dns_hostnames = true

  tags = {
    Name    = "network-segmentation-lab-segmented"
    Project = "network-segmentation-lab"
  }
}

resource "aws_internet_gateway" "lab" {
  vpc_id = aws_vpc.lab.id

  tags = {
    Name    = "network-segmentation-lab-igw"
    Project = "network-segmentation-lab"
  }
}

# --- Public subnet: faces the street. Routed to the internet gateway. ---

resource "aws_subnet" "public" {
  vpc_id                  = aws_vpc.lab.id
  cidr_block              = "10.0.1.0/24"
  map_public_ip_on_launch = true

  tags = {
    Name    = "network-segmentation-lab-public-subnet"
    Project = "network-segmentation-lab"
  }
}

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.lab.id

  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.lab.id
  }

  tags = {
    Name    = "network-segmentation-lab-public-rt"
    Project = "network-segmentation-lab"
  }
}

resource "aws_route_table_association" "public" {
  subnet_id      = aws_subnet.public.id
  route_table_id = aws_route_table.public.id
}

# --- Private subnet: behind the street. No route to the internet gateway at all. ---

resource "aws_subnet" "private" {
  vpc_id                  = aws_vpc.lab.id
  cidr_block              = "10.0.2.0/24"
  map_public_ip_on_launch = false

  tags = {
    Name    = "network-segmentation-lab-private-subnet"
    Project = "network-segmentation-lab"
  }
}

# Deliberately no 0.0.0.0/0 route here — only the implicit "local" route within
# the VPC. There is no path from the internet into this subnet at the routing
# layer, before security groups even get a say.
resource "aws_route_table" "private" {
  vpc_id = aws_vpc.lab.id

  tags = {
    Name    = "network-segmentation-lab-private-rt"
    Project = "network-segmentation-lab"
  }
}

resource "aws_route_table_association" "private" {
  subnet_id      = aws_subnet.private.id
  route_table_id = aws_route_table.private.id
}

# --- Security groups: scoped by role instead of one wide-open rule for everything. ---

resource "aws_security_group" "public_web" {
  name        = "network-segmentation-lab-public-web"
  description = "Public web tier: only HTTP/HTTPS in, from the internet"
  vpc_id      = aws_vpc.lab.id

  ingress {
    description = "HTTPS from anywhere"
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  ingress {
    description = "HTTP from anywhere (redirects to HTTPS)"
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
    Name    = "network-segmentation-lab-public-web"
    Project = "network-segmentation-lab"
  }
}

resource "aws_security_group" "private_db" {
  name        = "network-segmentation-lab-private-db"
  description = "Private db tier: only reachable from the public web tier, on the db port"
  vpc_id      = aws_vpc.lab.id

  ingress {
    description     = "Postgres, from the public web tier only - no CIDR, no 0.0.0.0/0"
    from_port       = 5432
    to_port         = 5432
    protocol        = "tcp"
    security_groups = [aws_security_group.public_web.id]
  }

  egress {
    description = "Within the VPC only - this subnet has no route to the internet anyway"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = [aws_vpc.lab.cidr_block]
  }

  tags = {
    Name    = "network-segmentation-lab-private-db"
    Project = "network-segmentation-lab"
  }
}

# --- Instances ---

resource "aws_instance" "web" {
  ami                         = var.ami_id
  instance_type               = var.instance_type
  subnet_id                   = aws_subnet.public.id
  vpc_security_group_ids      = [aws_security_group.public_web.id]
  associate_public_ip_address = true

  tags = {
    Name    = "network-segmentation-lab-web"
    Role    = "public-web"
    Project = "network-segmentation-lab"
  }
}

resource "aws_instance" "db" {
  ami                         = var.ami_id
  instance_type               = var.instance_type
  subnet_id                   = aws_subnet.private.id
  vpc_security_group_ids      = [aws_security_group.private_db.id]
  associate_public_ip_address = false

  tags = {
    Name    = "network-segmentation-lab-db"
    Role    = "private-db"
    Project = "network-segmentation-lab"
  }
}
