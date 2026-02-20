#!/bin/bash
# Ralph Loop for NanoClaw Memory System Implementation
# Keep running until all tasks are complete
# Based on the technique by Geoffrey Huntley

# Change to script directory to ensure we're in the right place
cd "$(dirname "$0")" || exit 1

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Configuration
PROMPT_FILE="docs/MEMORY_TASKS.md"
CHECKPOINT_FILE=".ralph-checkpoint"
MAX_ITERATIONS=50  # Safety limit
ITERATION=0

# Print header
echo -e "${BLUE}╔══════════════════════════════════════════════════╗${NC}"
echo -e "${BLUE}║     Ralph Loop - NanoClaw Memory System           ║${NC}"
echo -e "${BLUE}║     Iterating until memory system is complete      ║${NC}"
echo -e "${BLUE}╚══════════════════════════════════════════════════╝${NC}"
echo ""

# Check if prompt file exists
if [ ! -f "$PROMPT_FILE" ]; then
    echo -e "${RED}Error: $PROMPT_FILE not found!${NC}"
    echo "Please create the tasks document first."
    exit 1
fi

# Check if claude is available
if ! command -v claude &> /dev/null; then
    echo -e "${RED}Error: claude not found in PATH${NC}"
    echo "Please install Claude Code first."
    exit 1
fi

echo -e "${GREEN}✓ Claude Code found${NC}"
echo -e "${GREEN}✓ Tasks document found${NC}"
echo ""
echo -e "${YELLOW}Starting Ralph Loop...${NC}"
echo -e "${YELLOW}Will run until all tasks marked [ ] are done${NC}"
echo ""

# Main loop
while true; do
    ITERATION=$((ITERATION + 1))

    echo -e "${BLUE}════════════════════════════════════════════════════${NC}"
    echo -e "${BLUE}Iteration $ITERATION of $MAX_ITERATIONS${NC}"
    echo -e "${BLUE}Time: $(date '+%Y-%m-%d %H:%M:%S')${NC}"
    echo -e "${BLUE}════════════════════════════════════════════════════${NC}"
    echo ""

    # Safety check
    if [ $ITERATION -gt $MAX_ITERATIONS ]; then
        echo -e "${RED}⚠️  Reached maximum iterations ($MAX_ITERATIONS)${NC}"
        echo -e "${RED}Stopping to prevent infinite loop${NC}"
        break
    fi

    # Check if there are any incomplete tasks
    if grep -q "^\- \[ \]" "$PROMPT_FILE" 2>/dev/null; then
        # Count remaining tasks
        REMAINING=$(grep -c "^\- \[ \]" "$PROMPT_FILE")
        echo -e "${YELLOW}Tasks remaining: $REMAINING${NC}"
        echo ""

        # Show what's left to do
        echo -e "${YELLOW}Current incomplete tasks:${NC}"
        grep "^\- \[ \]" "$PROMPT_FILE" | head -5
        if [ $REMAINING -gt 5 ]; then
            echo -e "  ... and $((REMAINING - 5)) more"
        fi
        echo ""

        # Run Claude
        echo -e "${GREEN}Running Claude...${NC}"
        echo ""

        # Save current state
        echo "$ITERATION" > "$CHECKPOINT_FILE"

        # Run Claude with the prompt
        echo -e "${BLUE}→ Running: cat $PROMPT_FILE | claude --dangerously-skip-permissions --yes${NC}"
        echo ""

        # Run with timeout to prevent infinite hangs (5 minute limit per iteration)
        if timeout 300 cat "$PROMPT_FILE" | claude --dangerously-skip-permissions --yes 2>&1 | tee -a .ralph-log.txt; then
            EXIT_CODE=0
        else
            EXIT_CODE=$?
        fi

        EXIT_CODE=${PIPESTATUS[0]}
        echo ""

        if [ $EXIT_CODE -eq 0 ]; then
            echo -e "${GREEN}✓ Claude completed successfully${NC}"
        else
            echo -e "${YELLOW}⚠️  Claude exited with code $EXIT_CODE${NC}"
            echo -e "${YELLOW}Will try again...${NC}"
        fi

        # Check if any new commits were made
        if [ $ITERATION -gt 1 ]; then
            NEW_COMMITS=$(git diff HEAD~1 HEAD --name-only 2>/dev/null | wc -l)
            if [ "$NEW_COMMITS" -gt 0 ]; then
                echo -e "${GREEN}✓ New changes detected in git${NC}"

                # Rebuild if TypeScript files changed
                if git diff HEAD~1 HEAD --name-only 2>/dev/null | grep -q "\.ts$"; then
                    echo -e "${BLUE}→ Rebuilding TypeScript...${NC}"
                    if npm run build > /dev/null 2>&1; then
                        echo -e "${GREEN}✓ Build successful${NC}"
                    else
                        echo -e "${RED}✗ Build failed${NC}"
                    fi
                fi
            fi
        fi

    else
        # All tasks are complete!
        echo -e "${GREEN}╔══════════════════════════════════════════════════╗${NC}"
        echo -e "${GREEN}║                                                  ║${NC}"
        echo -e "${GREEN}║     🎉 ALL TASKS COMPLETE! 🎉                       ║${NC}"
        echo -e "${GREEN}║                                                  ║${NC}"
        echo -e "${GREEN}╚══════════════════════════════════════════════════╝${NC}"
        echo ""

        # Show final status
        echo -e "${GREEN}Final task status:${NC}"
        grep "^\- \[x\]" "$PROMPT_FILE" | head -20
        echo ""
        echo -e "${GREEN}Total iterations: $ITERATION${NC}"
        echo -e "${GREEN}Time taken: $(date '+%Y-%m-%d %H:%M:%S')${NC}"
        echo ""

        # Clean up
        rm -f "$CHECKPOINT_FILE"

        echo -e "${GREEN}✓ Ralph Loop complete!${NC}"
        exit 0
    fi

    # Small delay between iterations
    echo -e "${BLUE}Waiting 2 seconds before next iteration...${NC}"
    echo ""
    sleep 2
done

# Should never reach here
echo -e "${RED}Unexpected exit${NC}"
exit 1
