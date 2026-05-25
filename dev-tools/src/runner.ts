/**
 * SauceScript Runner
 *
 * Core compilation and execution logic for SauceScript files.
 * Used by scripts/run.ts CLI and can be imported programmatically.
 */

import { createPublicClient, createWalletClient, http, parseAbi, Hex, defineChain } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { readFileSync } from 'fs'
import { createRequire } from 'module'

const require = createRequire(import.meta.url)
const { compile } = require('@eco/sauce-compiler')

const sauceAbi = parseAbi([
  'function cook(bytes[] memory calls) public payable returns (bytes memory)'
])

export function parseArg(arg: string): bigint | string {
  // Hex strings longer than 32 bytes (66 chars with 0x) are passed as bytes, not bigint
  if (arg.startsWith('0x') && arg.length > 66) {
    return arg
  }
  return BigInt(arg)
}

function toHex(bytes: Uint8Array): Hex {
  return ('0x' + Buffer.from(bytes).toString('hex')) as Hex
}

export interface CompileScriptResult {
  /** Compiled bytecode segments (ready for cook()) */
  bytecodes: Hex[]
  /** Any compiler warnings */
  warnings: string[]
}

/**
 * Compile a SauceScript file to bytecode segments.
 */
export function compileScript(scriptPath: string, baseDir: string, args?: (bigint | string)[]): CompileScriptResult {
  const sauceScript = readFileSync(scriptPath, 'utf-8')

  const result = compile(sauceScript, {
    baseDirs: [baseDir],
    args: args && args.length > 0 ? args : undefined,
  })

  return {
    bytecodes: result.bytecode.map(toHex),
    warnings: result.warnings,
  }
}

export interface RunOptions {
  scriptPath: string
  scriptArgs?: (bigint | string)[]
  sauceAddress: string
  rpcUrl: string
  forkUrl?: string
  /** Project root directory where node_modules/ lives (for import resolution) */
  baseDir: string
}

/**
 * Compile and execute a SauceScript on a Sauce contract.
 */
export async function executeScript(options: RunOptions): Promise<void> {
  const { scriptPath, scriptArgs = [], sauceAddress, rpcUrl, forkUrl, baseDir } = options

  console.log('=== SauceScript Runner ===\n')
  console.log('File:', scriptPath)
  console.log('Sauce contract:', sauceAddress)
  console.log('RPC URL:', rpcUrl)
  if (forkUrl) {
    console.log('Fork URL:', forkUrl)
  }
  if (scriptArgs.length > 0) {
    console.log('Arguments:', scriptArgs.map(a => a.toString()).join(', '))
  }
  console.log('')

  // Read and display source
  const sauceScript = readFileSync(scriptPath, 'utf-8')
  console.log('Source code:')
  console.log(sauceScript)

  console.log('Compiling...')
  const compiled = compileScript(scriptPath, baseDir, scriptArgs.length > 0 ? scriptArgs : undefined)

  console.log('Segments:', compiled.bytecodes.length)
  for (let i = 0; i < compiled.bytecodes.length; i++) {
    const seg = compiled.bytecodes[i]
    console.log(`  [${i}] ${(seg.length - 2) / 2} bytes: ${seg.slice(0, 42)}${seg.length > 42 ? '...' : ''}`)
  }

  if (compiled.warnings.length > 0) {
    console.log('\nWarnings:')
    compiled.warnings.forEach((w) => console.log('  -', w))
  }

  // Set up viem clients (using Anvil's default pre-funded account)
  const privateKey = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'
  const account = privateKeyToAccount(privateKey)

  // Fetch the actual chain ID from the RPC (fork may use original chain ID)
  const tempClient = createPublicClient({ transport: http(rpcUrl) })
  const chainId = await tempClient.getChainId()

  const chain = defineChain({
    id: chainId,
    name: 'Anvil',
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } }
  })

  const publicClient = createPublicClient({
    chain,
    transport: http(rpcUrl)
  })

  const walletClient = createWalletClient({
    account,
    chain,
    transport: http(rpcUrl)
  })

  console.log('\nExecuting on Sauce contract...')
  console.log('Caller:', account.address)

  // Call cook() with the compiled bytecode segments
  const hash = await walletClient.writeContract({
    address: sauceAddress as Hex,
    abi: sauceAbi,
    functionName: 'cook',
    args: [compiled.bytecodes],
    chain,
    account
  })

  console.log('Transaction hash:', hash)

  // Wait for the transaction receipt
  const receipt = await publicClient.waitForTransactionReceipt({ hash })
  console.log('Transaction status:', receipt.status)

  // Simulate to get the return value
  const returnData = await publicClient.simulateContract({
    address: sauceAddress as Hex,
    abi: sauceAbi,
    functionName: 'cook',
    args: [compiled.bytecodes],
    account: account.address,
    chain
  })

  console.log('\nReturn value:', returnData.result)
  console.log('\nDone!')
}
