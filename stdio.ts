#!/usr/bin/env node
/**
 * docs-mcp — stdio MCP server.
 *
 * Speaks JSON-RPC 2024-11-05 over stdin/stdout. Compatible with Claude Code,
 * Cursor, and any other MCP client using the stdio transport. See README for
 * config and required env vars.
 */

import { createInterface } from 'node:readline'
import * as github from './github.js'
import { validateSpecFormat, generateBranchName, isValidFeatureName } from './validators.js'

const DOCS_PATH = process.env.DOCS_PATH || '.docs/features'
const DOC_FILENAME_MODE = (process.env.DOC_FILENAME_MODE || 'prefixed') as 'prefixed' | 'flat'

function docFilePath(featureName: string, docType: string): string {
  const file = DOC_FILENAME_MODE === 'flat'
    ? `${docType}.md`
    : `${featureName}_${docType}.md`
  return `${DOCS_PATH}/${featureName}/${file}`
}

const SERVER_INFO = {
  name: 'docs-mcp',
  version: '2.0.0',
  protocolVersion: '2024-11-05',
}

interface MCPTool {
  name: string
  description: string
  inputSchema: {
    type: 'object'
    properties: Record<string, unknown>
    required?: string[]
  }
}

const TOOLS: MCPTool[] = [
  {
    name: 'list_feature_docs',
    description: 'List all feature documentation folders in .docs/features/',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'read_feature_doc',
    description: 'Read a feature document (spec, plan or tasks) from the repository',
    inputSchema: {
      type: 'object',
      properties: {
        feature_name: { type: 'string', description: 'Feature folder name (kebab-case)' },
        doc_type: { type: 'string', enum: ['spec', 'plan', 'tasks'], description: 'Document type' },
      },
      required: ['feature_name', 'doc_type'],
    },
  },
  {
    name: 'validate_spec',
    description: 'Validate spec markdown for required sections (dry-run, no commit)',
    inputSchema: {
      type: 'object',
      properties: {
        content: { type: 'string', description: 'Spec markdown content to validate' },
      },
      required: ['content'],
    },
  },
  {
    name: 'write_feature_doc',
    description: 'Create or update a feature document via GitHub commit. Automatically creates a new branch.',
    inputSchema: {
      type: 'object',
      properties: {
        feature_name: { type: 'string', description: 'Feature folder name (kebab-case)' },
        doc_type: { type: 'string', enum: ['spec', 'plan', 'tasks'], description: 'Document type' },
        content: { type: 'string', description: 'Markdown content' },
        commit_message: { type: 'string', description: 'Commit message' },
        branch: { type: 'string', description: 'Existing branch (optional)' },
      },
      required: ['feature_name', 'doc_type', 'content', 'commit_message'],
    },
  },
  {
    name: 'create_docs_pr',
    description: 'Create a pull request for documentation changes',
    inputSchema: {
      type: 'object',
      properties: {
        branch: { type: 'string', description: 'Source branch with changes' },
        title: { type: 'string', description: 'PR title' },
        body: { type: 'string', description: 'PR description (optional)' },
      },
      required: ['branch', 'title'],
    },
  },
]

function validateInput(value: string, maxLength: number, fieldName: string): string | null {
  if (!value || typeof value !== 'string') return `${fieldName} is required`
  if (value.length > maxLength) return `${fieldName} exceeds max length (${maxLength})`
  return null
}

async function handleListFeatureDocs(): Promise<unknown> {
  const contents = await github.listContents(DOCS_PATH)
  const features = contents
    .filter((item) => item.type === 'dir')
    .map((dir) => ({ name: dir.name, path: dir.path, url: dir.html_url }))
  return { features, count: features.length }
}

async function handleReadFeatureDoc(args: Record<string, unknown>): Promise<unknown> {
  const featureName = args.feature_name as string
  const docType = args.doc_type as string

  if (!featureName || !docType) throw new Error('feature_name and doc_type are required')
  const nameErr = validateInput(featureName, 50, 'feature_name')
  if (nameErr) throw new Error(nameErr)
  if (!isValidFeatureName(featureName)) throw new Error('feature_name must be kebab-case')
  if (!['spec', 'plan', 'tasks'].includes(docType)) throw new Error('doc_type must be spec, plan or tasks')

  const filePath = docFilePath(featureName, docType)
  const file = await github.readFile(filePath)
  return {
    feature_name: featureName,
    doc_type: docType,
    content: file.content,
    sha: file.sha,
    size: file.size,
    path: file.path,
  }
}

function handleValidateSpec(args: Record<string, unknown>): unknown {
  const content = args.content as string
  if (!content) throw new Error('content is required')
  const contentErr = validateInput(content, 100000, 'content')
  if (contentErr) throw new Error(contentErr)
  return validateSpecFormat(content)
}

async function handleWriteFeatureDoc(args: Record<string, unknown>): Promise<unknown> {
  const featureName = args.feature_name as string
  const docType = args.doc_type as string
  const content = args.content as string
  const commitMessage = args.commit_message as string
  let branch = args.branch as string | undefined

  if (!featureName || !docType || !content || !commitMessage) {
    throw new Error('feature_name, doc_type, content and commit_message are required')
  }
  const nameErr = validateInput(featureName, 50, 'feature_name')
  if (nameErr) throw new Error(nameErr)
  if (!isValidFeatureName(featureName)) throw new Error('feature_name must be kebab-case')
  if (!['spec', 'plan', 'tasks'].includes(docType)) throw new Error('doc_type must be spec, plan or tasks')
  const contentErr = validateInput(content, 100000, 'content')
  if (contentErr) throw new Error(contentErr)
  const msgErr = validateInput(commitMessage, 200, 'commit_message')
  if (msgErr) throw new Error(msgErr)

  if (docType === 'spec') {
    const validation = validateSpecFormat(content)
    if (!validation.valid) {
      return {
        error: 'Spec validation failed',
        missing_sections: validation.missing_sections,
        found_sections: validation.found_sections,
      }
    }
  }

  if (!branch) {
    branch = generateBranchName(featureName)
    await github.createBranch(branch)
  }

  const filePath = docFilePath(featureName, docType)
  const existingSha = await github.getFileSha(filePath, branch)
  const commit = await github.createOrUpdateFile({
    path: filePath,
    message: commitMessage,
    content,
    branch,
    sha: existingSha ?? undefined,
  })

  return { success: true, commit, branch, file_path: filePath }
}

async function handleCreateDocsPr(args: Record<string, unknown>): Promise<unknown> {
  const branch = args.branch as string
  const title = args.title as string
  const body = args.body as string | undefined

  if (!branch || !title) throw new Error('branch and title are required')
  const branchErr = validateInput(branch, 100, 'branch')
  if (branchErr) throw new Error(branchErr)
  const titleErr = validateInput(title, 200, 'title')
  if (titleErr) throw new Error(titleErr)

  const pr = await github.createPullRequest({ title, head: branch, body, labels: ['docs'] })
  return { success: true, pr_number: pr.number, pr_url: pr.html_url, state: pr.state }
}

async function executeTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    case 'list_feature_docs': return handleListFeatureDocs()
    case 'read_feature_doc': return handleReadFeatureDoc(args)
    case 'validate_spec': return handleValidateSpec(args)
    case 'write_feature_doc': return handleWriteFeatureDoc(args)
    case 'create_docs_pr': return handleCreateDocsPr(args)
    default: throw new Error(`Unknown tool: ${name}`)
  }
}

interface MCPRequest {
  jsonrpc: '2.0'
  id: string | number
  method: string
  params?: Record<string, unknown>
}

interface MCPResponse {
  jsonrpc: '2.0'
  id: string | number
  result?: unknown
  error?: { code: number; message: string }
}

async function handleMCPRequest(request: MCPRequest): Promise<MCPResponse> {
  const { id, method, params } = request

  try {
    switch (method) {
      case 'initialize':
        return {
          jsonrpc: '2.0',
          id,
          result: {
            protocolVersion: SERVER_INFO.protocolVersion,
            capabilities: { tools: {} },
            serverInfo: { name: SERVER_INFO.name, version: SERVER_INFO.version },
          },
        }
      case 'tools/list':
        return { jsonrpc: '2.0', id, result: { tools: TOOLS } }
      case 'tools/call': {
        const toolName = params?.name as string
        const toolArgs = (params?.arguments as Record<string, unknown>) || {}
        if (!toolName) {
          return { jsonrpc: '2.0', id, error: { code: -32602, message: 'Missing tool name' } }
        }
        const result = await executeTool(toolName, toolArgs)
        return {
          jsonrpc: '2.0',
          id,
          result: { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] },
        }
      }
      default:
        return { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } }
    }
  } catch (error) {
    return {
      jsonrpc: '2.0',
      id,
      error: { code: -32603, message: error instanceof Error ? error.message : 'Internal error' },
    }
  }
}

// stdio transport — line-delimited JSON-RPC
const rl = createInterface({ input: process.stdin })

rl.on('line', async (line) => {
  const trimmed = line.trim()
  if (!trimmed) return

  let request: MCPRequest
  try {
    request = JSON.parse(trimmed) as MCPRequest
  } catch {
    process.stdout.write(JSON.stringify({
      jsonrpc: '2.0',
      id: null,
      error: { code: -32700, message: 'Parse error' },
    }) + '\n')
    return
  }

  const response = await handleMCPRequest(request)
  process.stdout.write(JSON.stringify(response) + '\n')
})

rl.on('close', () => process.exit(0))
