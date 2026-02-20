---
name: agent-delegation
description: Delegate tasks to other specialist agents. Use whenever a task would be better handled by another agent.
allowed-tools: Bash
---

# Agent Delegation

## Quick Start

Just use the `delegate_to` bash command:

```bash
delegate_to hali "Write a 1000-word blog post about AI bots in 2025"
```

## How It Works

The `delegate_to` command writes an IPC message that triggers the target agent. They will respond directly to the user. Your container exits after delegating - you don't wait for the response.

## Available Agents

**C-Suite:**
- `lucy` - Chief Operations Officer (main entry point)
- `nalu` - Chief Technology Officer
- `maui` - Chief Marketing Officer
- `hoku` - Chief Revenue Officer

**Tech Team (Nalu):**
- `reef` - Backend Engineer
- `pali` - Security Analyst
- `mana` - Frontend Developer
- `ahi` - DevOps
- `liko` - QA Engineer

**Marketing Team (Maui):**
- `hali` - Blog Writer
- `moana` - Social Media
- `koa` - SEO Specialist
- `leilani` - Newsletter
- `noelani` - Graphic Design
- `ikaika` - Video Production

**Revenue Team (Hoku):**
- `kai` - Product Analyst
- `wai` - Pricing Strategist
- `makani` - Growth Hacker
- `lani` - Partnerships
- `keoni` - Community Manager
- `pua` - Support Lead
- `noe` - Feedback Analyst

## Usage Examples

```bash
# Blog post
delegate_to hali "Write a 1500-word blog post about remote work best practices. Include: productivity tips, tools, and mental health advice."

# Social media campaign
delegate_to moana "Create a week's worth of Twitter posts about our new feature. Include hashtags and CTAs."

# Technical review
delegate_to nalu "Review the authentication system in groups/lucy/ for security vulnerabilities."

# SEO optimization
delegate_to koa "Analyze our homepage for SEO opportunities and provide keyword recommendations."

# Pricing strategy
delegate_to wai "Research competitor pricing for SaaS analytics tools and recommend our pricing tiers."
```

## Best Practices

1. **Be specific** - Include word counts, tone, platforms, deadlines
2. **Provide context** - Explain why this task matters
3. **Set clear expectations** - Define deliverables clearly
4. **Delegate to the right specialist** - Match the task to the expert

## After Delegating

Your job is done! The target agent will:
1. Receive the delegated task
2. Execute it using their specialized skills
3. Respond directly to the user

You do NOT need to wait for or acknowledge their response - your container will exit after delegating.
