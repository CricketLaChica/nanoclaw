# Agent Communication & Host Commands

This skill provides tools for:
- Scheduling persistent cron jobs that run on the host (survive container lifecycle)
- Sending messages to other agents for delegation and collaboration

## Tools

### scheduleHostCommand

Schedule a command to run on the HOST (persistent, survives container restarts).

**Usage:**
```bash
scheduleHostCommand "<cron expression>" "<command to run>"
```

**Examples:**
```bash
# Run every day at 9am
scheduleHostCommand "0 9 * * *" "echo 'Good morning!' | osascript -e 'display notification \"Good Morning!\"'"

# Run every hour
scheduleHostCommand "0 * * * *" "echo 'Hourly check' >> /tmp/health.log"

# Run every 30 minutes
scheduleHostCommand "*/30 * * * *" "curl -s https://healthcheck.example.com/ping"

# Run once at specific time
scheduleHostCommand "once" "0 18 * * *" "echo '6pm check'"
```

**Schedule Types:**
- `cron "<cron>"` - Cron schedule (e.g., "0 9 * * *" for 9am daily)
- `interval <ms>` - Repeat every N milliseconds
- `once` - Run once at specified time

### sendMessage

Send a message to another agent.

**Usage:**
```bash
sendMessage <agent-id> "<your message>"
```

**Available Agents:**
- **lucy** - Chief Operations Officer (main entry point)
- **nalu** - Chief Technology Officer
- **maui** - Chief Marketing Officer
- **hoku** - Chief Revenue Officer
- **reef** - Backend Engineer (Nalu's team)
- **pali** - Security Analyst (Nalu's team)
- **mana** - Frontend Dev (Nalu's team)
- **ahi** - DevOps (Nalu's team)
- **liko** - QA Engineer (Nalu's team)
- **hali** - Blog Writer (Maui's team)
- **moana** - Social Media (Maui's team)
- **koa** - SEO Specialist (Maui's team)
- **leilani** - Newsletter (Maui's team)
- **noelani** - Graphic Design (Maui's team)
- **ikaika** - Video Production (Maui's team)
- **kai** - Product Analyst (Hoku's team)
- **wai** - Pricing Strategist (Hoku's team)
- **makani** - Growth Hacker (Hoku's team)
- **lani** - Partnerships (Hoku's team)
- **keoni** - Community Manager (Hoku's team)
- **pua** - Support Lead (Hoku's team)
- **noe** - Feedback Analyst (Hoku's team)

**Example:**
```bash
# Lucy delegates to Nalu
sendMessage nalu "The user needs help with backend architecture. Please review."

# Lucy asks Maui for marketing content
sendMessage maui "Create a blog post about our new features."

# Request detailed analysis
sendMessage noe "Please analyze the user feedback from the last conversation."
```

## Implementation

These tools work through NanoClaw's persistent scheduler and IPC system:
- Host commands run in the NanoClaw process (not containers), making them persistent
- Agent messages use IPC files that containers poll for messages
- All communication is asynchronous and tracked
