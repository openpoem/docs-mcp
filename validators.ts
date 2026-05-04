/**
 * Spec validation and helpers for docs-mcp.
 */

export const REQUIRED_SPEC_SECTIONS = [
  '## 1. Overview',
  '## 2. Users & Stakeholders',
  '## 3. User Journeys',
  '## 4. Experience Requirements',
  '## 5. Success Metrics',
]

export interface ValidationResult {
  valid: boolean
  missing_sections: string[]
  found_sections: string[]
}

export function validateSpecFormat(content: string): ValidationResult {
  const found: string[] = []
  const missing: string[] = []

  for (const section of REQUIRED_SPEC_SECTIONS) {
    if (content.includes(section)) found.push(section)
    else missing.push(section)
  }

  return {
    valid: missing.length === 0,
    missing_sections: missing,
    found_sections: found,
  }
}

export function generateBranchName(featureName: string): string {
  const timestamp = Math.floor(Date.now() / 1000)
  const safeName = featureName.replace(/[^a-z0-9-]/gi, '-').toLowerCase()
  return `docs/${safeName}-${timestamp}`
}

export function isValidFeatureName(name: string): boolean {
  return /^[a-z0-9][a-z0-9-]{0,48}[a-z0-9]$/.test(name) || /^[a-z0-9]$/.test(name)
}
