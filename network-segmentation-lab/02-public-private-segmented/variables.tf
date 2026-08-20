variable "aws_region" {
  type        = string
  description = "AWS region to deploy into"
  default     = "us-east-1"
}

variable "ami_id" {
  type        = string
  description = "AMI to launch. Placeholder — replace with a real AMI ID for your region before applying."
  default     = "ami-0000000000000000"
}

variable "instance_type" {
  type        = string
  description = "Instance type for both the web and db instances"
  default     = "t3.micro"
}
