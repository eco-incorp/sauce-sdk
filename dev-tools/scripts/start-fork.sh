#!/bin/bash
set -e

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

if [ -z "$1" ]; then
    echo "Usage: npm run start:fork <rpc-url>"
    echo "Example: npm run start:fork https://eth-mainnet.g.alchemy.com/v2/YOUR_KEY"
    exit 1
fi

FORK_URL="$1"

# Optional pinned block (2nd arg or $FORK_BLOCK env). Pinning enables Hardhat's
# persistent on-disk fork cache (~/.cache/hardhat-nodejs/hardhat-network-fork/,
# keyed by chainId+block) so state is reused across runs, and makes runs
# deterministic. Without it, Hardhat forks "latest" and caches in memory only.
FORK_BLOCK="${2:-$FORK_BLOCK}"
BLOCK_ARG=""
if [ -n "$FORK_BLOCK" ]; then
    BLOCK_ARG="--fork-block-number $FORK_BLOCK"
fi

# Check for Sauce artifact
if [ ! -f "$REPO_ROOT/artifacts/ISauceRouter.json" ]; then
    echo "Error: artifacts/ISauceRouter.json not found."
    echo "Run './engine/export-artifact.sh' from the repo root to generate it."
    exit 1
fi

if [ -n "$FORK_BLOCK" ]; then
    echo -e "${YELLOW}Starting Hardhat (forking $FORK_URL @ block $FORK_BLOCK, persistent cache)...${NC}"
else
    echo -e "${YELLOW}Starting Hardhat (forking $FORK_URL @ latest, in-memory cache only)...${NC}"
fi

# Kill any existing process on port 8545
if lsof -i :8545 > /dev/null 2>&1; then
    echo "Port 8545 in use. Killing existing process..."
    lsof -ti :8545 | xargs kill -9 2>/dev/null || true
    sleep 1
fi

# Start Hardhat node with forking in background
cd "$REPO_ROOT"
npx hardhat node --fork "$FORK_URL" $BLOCK_ARG > "$REPO_ROOT/.hardhat.log" 2>&1 &
HARDHAT_PID=$!

# Wait for hardhat to be ready
echo "Waiting for Hardhat..."
for i in {1..60}; do
    if curl -s -X POST -H 'Content-Type: application/json' \
        --data '{"jsonrpc":"2.0","method":"eth_blockNumber","params":[],"id":1}' \
        http://127.0.0.1:8545 > /dev/null 2>&1; then
        break
    fi
    if ! kill -0 $HARDHAT_PID 2>/dev/null; then
        echo "Failed to start Hardhat. Check .hardhat.log for details."
        cat "$REPO_ROOT/.hardhat.log"
        exit 1
    fi
    sleep 1
done

if ! curl -s -X POST -H 'Content-Type: application/json' \
    --data '{"jsonrpc":"2.0","method":"eth_blockNumber","params":[],"id":1}' \
    http://127.0.0.1:8545 > /dev/null 2>&1; then
    echo "Hardhat failed to respond. Check .hardhat.log for details."
    kill $HARDHAT_PID 2>/dev/null
    exit 1
fi

echo -e "${GREEN}Hardhat running (PID: $HARDHAT_PID)${NC}"

# Deploy Sauce
echo -e "${YELLOW}Deploying Sauce...${NC}"
DEPLOY_OUTPUT=$(npx tsx scripts/deploy.ts 2>&1)

SAUCE_ADDRESS=$(echo "$DEPLOY_OUTPUT" | grep "SAUCE_ADDRESS=" | cut -d'=' -f2)

if [ -z "$SAUCE_ADDRESS" ]; then
    echo "Failed to deploy Sauce contract:"
    echo "$DEPLOY_OUTPUT"
    kill $HARDHAT_PID 2>/dev/null
    exit 1
fi

# Write deployment info
cat > "$REPO_ROOT/.deployment.json" << EOF
{"sauceAddress":"$SAUCE_ADDRESS","rpcUrl":"http://127.0.0.1:8545","forkUrl":"$FORK_URL","hardhatPid":$HARDHAT_PID}
EOF

echo ""
echo -e "${GREEN}========================================${NC}"
echo -e "${GREEN}       Ready!${NC}"
echo -e "${GREEN}========================================${NC}"
echo -e "${CYAN}Sauce:${NC}    $SAUCE_ADDRESS"
echo -e "${CYAN}RPC:${NC}      http://127.0.0.1:8545"
echo -e "${CYAN}Fork:${NC}     $FORK_URL"
echo ""
echo -e "Stop with: ${YELLOW}npm run stop${NC}"
