/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * PDF API Service — dual-mode adapter
 *
 * Resolves the correct API base URL depending on the deployment mode:
 *
 *   Mode A (Exe / Electron desktop):
 *     The FastAPI server is launched by the main process on localhost:8765.
 *     All PDF API calls go to http://127.0.0.1:8765.
 *
 *   Mode B (Web / Docker):
 *     The server is remote. API calls go to window.location.origin, or
 *     the value of the VITE_API_BASE_URL build-time variable when provided.
 *
 * Import this service wherever PDF functionality is needed instead of calling
 * the old Python scripts directly.
 */

import { isElectronDesktop } from '@/renderer/utils/platform';

// ---------------------------------------------------------------------------
// Base URL resolution
// ---------------------------------------------------------------------------

/** Port on which the local FastAPI server listens in Exe mode. */
const EXE_API_PORT = 8765;

/**
 * Resolve the base URL for the FastAPI PDF server.
 *
 * Priority order:
 *   1. VITE_API_BASE_URL environment variable (build-time override)
 *   2. Exe mode  → http://127.0.0.1:8765
 *   3. Web mode  → window.location.origin
 */
export function getPdfApiBaseUrl(): string {
  // Build-time override (e.g. VITE_API_BASE_URL=https://api.example.com)
  // Use unknown → cast to avoid tsconfig strict conflicts with import.meta shape.
  const meta = import.meta as unknown as Record<string, unknown>;
  const env = meta['env'] as Record<string, string> | undefined;
  const envOverride = env?.['VITE_API_BASE_URL'];
  if (envOverride) return envOverride.replace(/\/$/, '');

  if (isElectronDesktop()) {
    return `http://127.0.0.1:${EXE_API_PORT}`;
  }

  // Web mode: same origin as the front-end
  return typeof window !== 'undefined' ? window.location.origin : '';
}

// ---------------------------------------------------------------------------
// Internal fetch helper
// ---------------------------------------------------------------------------

type ApiResponse<T> = { success: true; data: T } | { success: false; error: string };

async function apiRequest<T>(
  endpoint: string,
  method: 'GET' | 'POST',
  body?: FormData | URLSearchParams
): Promise<ApiResponse<T>> {
  const base = getPdfApiBaseUrl();
  const url = `${base}${endpoint}`;

  try {
    const res = await fetch(url, {
      method,
      body: body ?? undefined,
      credentials: 'same-origin',
    });

    if (!res.ok) {
      let detail = `HTTP ${res.status} ${res.statusText}`;
      try {
        const json = (await res.json()) as { detail?: string };
        if (json.detail) detail = json.detail;
      } catch {
        /* ignore parse errors */
      }
      return { success: false, error: detail };
    }

    const contentType = res.headers.get('content-type') ?? '';
    if (contentType.includes('application/json')) {
      const data = (await res.json()) as T;
      return { success: true, data };
    }

    // Binary response — return as Blob
    const blob = await res.blob();
    return { success: true, data: blob as unknown as T };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { success: false, error: msg };
  }
}

// ---------------------------------------------------------------------------
// Health check
// ---------------------------------------------------------------------------

export type HealthStatus = { status: string; deploy_mode: string };

/**
 * Ping the FastAPI server. Useful for checking whether it is reachable
 * before initiating a file operation.
 */
export async function checkApiHealth(): Promise<ApiResponse<HealthStatus>> {
  return apiRequest<HealthStatus>('/health', 'GET');
}

// ---------------------------------------------------------------------------
// PDF split
// ---------------------------------------------------------------------------

export type SplitPdfInfoResult = {
  filename: string;
  total_pages: number;
  file_size_bytes: number;
  page_range?: string;
  extracted_page_count?: number;
  extracted_page_indices?: number[];
  mode: 'extract' | 'split_all';
  output_files?: string[];
};

/**
 * Inspect a PDF split operation without producing any output files.
 * Useful for previewing how many pages will be affected.
 *
 * @param file        The PDF file to inspect.
 * @param pageRange   Optional page range string (e.g. '1-5' or '1,3,5').
 */
export async function getPdfSplitInfo(file: File, pageRange?: string): Promise<ApiResponse<SplitPdfInfoResult>> {
  const form = new FormData();
  form.append('file', file);
  if (pageRange) form.append('page_range', pageRange);

  return apiRequest<SplitPdfInfoResult>('/pdf/split/info', 'POST', form);
}

/**
 * Split a PDF into individual pages or extract a page range.
 *
 *   - Without pageRange: returns a ZIP archive containing one PDF per page.
 *   - With pageRange:    returns a single PDF with the selected pages.
 *
 * @param file        The PDF file to split.
 * @param pageRange   Optional page range string (e.g. '1-5' or '1,3,5').
 * @returns           A Blob containing the resulting PDF or ZIP.
 */
export async function splitPdf(file: File, pageRange?: string): Promise<ApiResponse<Blob>> {
  const form = new FormData();
  form.append('file', file);
  if (pageRange) form.append('page_range', pageRange);

  return apiRequest<Blob>('/pdf/split', 'POST', form);
}

// ---------------------------------------------------------------------------
// PDF merge
// ---------------------------------------------------------------------------

/**
 * Merge two or more PDF files into a single PDF (in the given order).
 *
 * @param files  An array of at least 2 PDF File objects.
 * @returns      A Blob containing the merged PDF.
 */
export async function mergePdfs(files: File[]): Promise<ApiResponse<Blob>> {
  if (files.length < 2) {
    return { success: false, error: 'At least 2 PDF files are required for merging.' };
  }

  const form = new FormData();
  for (const f of files) {
    form.append('files', f);
  }

  return apiRequest<Blob>('/pdf/merge', 'POST', form);
}

// ---------------------------------------------------------------------------
// PDF to images
// ---------------------------------------------------------------------------

/**
 * Convert each page of a PDF to an image and receive a ZIP archive.
 *
 * @param file  The PDF file to convert.
 * @param dpi   Rendering resolution (72–600, default 150).
 * @param fmt   Image format: 'PNG' (default) or 'JPEG'.
 * @returns     A Blob containing a ZIP with one image per page.
 */
export async function convertPdfToImages(
  file: File,
  dpi = 150,
  fmt: 'PNG' | 'JPEG' = 'PNG'
): Promise<ApiResponse<Blob>> {
  const form = new FormData();
  form.append('file', file);
  form.append('dpi', String(dpi));
  form.append('fmt', fmt);

  return apiRequest<Blob>('/pdf/convert', 'POST', form);
}

// ---------------------------------------------------------------------------
// PDF form — check fillable fields
// ---------------------------------------------------------------------------

export type PdfFieldInfo = {
  name: string;
  type_code: string;
  type_name: string;
};

export type PdfFormCheckResult = {
  has_fields: boolean;
  field_count: number;
  fields: PdfFieldInfo[];
};

/**
 * Return all fillable AcroForm field names and types found in a PDF.
 *
 * @param file  The PDF file to inspect.
 */
export async function checkPdfFormFields(file: File): Promise<ApiResponse<PdfFormCheckResult>> {
  const form = new FormData();
  form.append('file', file);

  return apiRequest<PdfFormCheckResult>('/pdf/form/check', 'POST', form);
}

// ---------------------------------------------------------------------------
// PDF form — fill fields
// ---------------------------------------------------------------------------

/**
 * Fill AcroForm fields in a PDF and receive the filled PDF as a Blob.
 *
 * @param file         The PDF file with fillable fields.
 * @param fieldValues  A map of field name → value.
 *                     Checkbox fields typically use '/On' or '/Off'.
 * @returns            A Blob containing the filled PDF.
 */
export async function fillPdfFormFields(file: File, fieldValues: Record<string, string>): Promise<ApiResponse<Blob>> {
  const form = new FormData();
  form.append('file', file);
  form.append('field_values', JSON.stringify(fieldValues));

  return apiRequest<Blob>('/pdf/form/fill', 'POST', form);
}

// ---------------------------------------------------------------------------
// Skill management API
// ---------------------------------------------------------------------------

export type SkillInitResult = {
  success: boolean;
  skill_name: string;
  skill_title: string;
  skill_dir: string;
  created_dirs: string[];
  created_files: string[];
  next_steps: string[];
};
export type SkillValidateResult = {
  valid: boolean;
  message: string;
  mode: 'content' | 'path';
  skill_name?: string;
  description?: string;
  skill_path?: string;
};
export type SkillPackageResult = Blob;

/**
 * Create a new skill directory with template files.
 *
 * @param skillName  Hyphen-case skill name (e.g. 'my-skill').
 * @param basePath   Parent directory in which the skill folder will be created.
 */
export async function initSkill(skillName: string, basePath: string): Promise<ApiResponse<SkillInitResult>> {
  const form = new FormData();
  form.append('skill_name', skillName);
  form.append('path', basePath);

  return apiRequest<SkillInitResult>('/admin/skills/init', 'POST', form);
}

/**
 * Validate a skill directory's SKILL.md frontmatter.
 *
 * @param skillPath  Absolute path to the skill directory.
 */
export async function validateSkill(skillPath: string): Promise<ApiResponse<SkillValidateResult>> {
  const form = new FormData();
  form.append('skill_path', skillPath);

  return apiRequest<SkillValidateResult>('/admin/skills/validate', 'POST', form);
}

/**
 * Package a skill directory into a .skill (ZIP) archive.
 * Returns the archive as a Blob (application/zip).
 *
 * @param skillPath  Absolute path to the skill directory.
 */
export async function packageSkill(skillPath: string): Promise<ApiResponse<SkillPackageResult>> {
  const form = new FormData();
  form.append('skill_path', skillPath);

  return apiRequest<SkillPackageResult>('/admin/skills/package', 'POST', form);
}
