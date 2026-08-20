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

# --- One VPC, one subnet, one security group. No public/private split at all. ---

resource "aws_vpc" "lab" {
  cidr_block           = "10.0.0.0/16"
  enable_dns_support   = true
  enable_dns_hostnames = true

  tags = {
    Name    = "network-segmentation-lab-flat"
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

resource "aws_subnet" "flat" {
  vpc_id                  = aws_vpc.lab.id
  cidr_block              = "10.0.1.0/24"
  map_public_ip_on_launch = true

  tags = {
    Name    = "network-segmentation-lab-flat-subnet"
    Project = "network-segmentation-lab"
  }
}

resource "aws_route_table" "flat" {
  vpc_id = aws_vpc.lab.id

  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.lab.id
  }

  tags = {
    Name    = "network-segmentation-lab-flat-rt"
    Project = "network-segmentation-lab"
  }
}

resource "aws_route_table_association" "flat" {
  subnet_id      = aws_subnet.flat.id
  route_table_id = aws_route_table.flat.id
}

# Every port, every protocol, from anywhere. The network equivalent of ec2:* on Resource: "*".
resource "aws_security_group" "wide_open" {
  name        = "network-segmentation-lab-wide-open"
  description = "Overbroad: allows all traffic from the entire internet, in both directions"
  vpc_id      = aws_vpc.lab.id

  ingress {
    description = "All ports, all protocols, from anywhere"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  egress {
    description = "All ports, all protocols, to anywhere"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = {
    Name    = "network-segmentation-lab-wide-open"
    Project = "network-segmentation-lab"
  }
}

# The "public" tier: this one is supposed to face the street.
resource "aws_instance" "web" {
  ami                         = var.ami_id
  instance_type               = var.instance_type
  subnet_id                   = aws_subnet.flat.id
  vpc_security_group_ids      = [aws_security_group.wide_open.id]
  associate_public_ip_address = true

  tags = {
    Name    = "network-segmentation-lab-web"
    Role    = "public-web"
    Project = "network-segmentation-lab"
  }
}

# The "private" tier: same subnet, same wide-open security group, same public IP.
# Nothing here actually keeps it behind the street — it's directly reachable from
# the internet on every port, identically to the web instance.
resource "aws_instance" "db" {
  ami                         = var.ami_id
  instance_type               = var.instance_type
  subnet_id                   = aws_subnet.flat.id
  vpc_security_group_ids      = [aws_security_group.wide_open.id]
  associate_public_ip_address = true

  tags = {
    Name    = "network-segmentation-lab-db"
    Role    = "should-be-private"
    Project = "network-segmentation-lab"
  }
}
