import Tesseract from 'tesseract.js';
import { Capacitor } from '@capacitor/core';
import { Filesystem, Directory } from '@capacitor/filesystem';
import { TextRecognition, Script } from '@capacitor-mlkit/text-recognition';

export interface ParsedBillItem {
  hsn_code: string;
  raw_particulars: string;
  matched_item_name: string;
  master_item_id: string | null;
  qty_or_kg: number;
  unit_rate: number;
  total_value: number;
}

export interface ParsedBill {
  store_name: string;
  bill_date: string;
  month_year: string;
  bill_number: string;
  total_items_count: number;
  total_qty_count: number;
  total_amount: number;
  total_savings: number;
  items: ParsedBillItem[];
}

export interface MasterItem {
  id: string;
  name: string;
  category: string;
  sub_category?: string;
  default_unit: string;
  default_qty: number;
  dmart_aliases: string[];
}

// 1. Compress & Resize image on Canvas (1024px max keeps payload tiny to avoid 503 timeouts)
export async function compressImageToBase64(
  file: File,
  maxDim = 1024
): Promise<{ base64: string; mimeType: string; dataUrl: string }> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      let width = img.width;
      let height = img.height;

      if (width > maxDim || height > maxDim) {
        if (width > height) {
          height = Math.round((height * maxDim) / width);
          width = maxDim;
        } else {
          width = Math.round((width * maxDim) / height);
          height = maxDim;
        }
      }

      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      if (!ctx) return reject(new Error('Canvas context unavailable'));

      ctx.drawImage(img, 0, 0, width, height);
      const dataUrl = canvas.toDataURL('image/jpeg', 0.78);
      resolve({
        base64: dataUrl.split(',')[1],
        mimeType: 'image/jpeg',
        dataUrl
      });
    };
    img.onerror = () => reject(new Error('Failed to load image file'));
    img.src = URL.createObjectURL(file);
  });
}

// 2. Local Generalized Catalog Matcher (Matches raw bill text against Supabase master_items in <1ms)
export function matchToMasterItem(rawText: string, catalog: MasterItem[]): { id: string | null; name: string } {
  const normalized = rawText.trim().toUpperCase();
  if (!normalized) return { id: null, name: '' };

  for (const item of catalog) {
    if (
      item.dmart_aliases?.some(
        alias => normalized === alias.toUpperCase() || normalized.includes(alias.toUpperCase())
      )
    ) {
      return { id: item.id, name: item.name };
    }
  }

  const cleaned = normalized
    .replace(/^(L|UD|M)\s+/i, '')
    .replace(/-\s*\d+(?:\.\d+)?\s*(?:kg|g|gm|lt|l|ml|nos|pc|pcs|pkt)$/i, '')
    .trim();

  for (const item of catalog) {
    const masterUpper = item.name.toUpperCase();
    if (cleaned === masterUpper || cleaned.includes(masterUpper) || masterUpper.includes(cleaned)) {
      return { id: item.id, name: item.name };
    }
  }

  return { id: null, name: rawText.trim() };
}

// Helper: Normalize raw JSON output from any Vision API into ParsedBill
function normalizeVisionJsonToBill(parsed: any, catalog: MasterItem[]): ParsedBill {
  const rawItems = Array.isArray(parsed?.items) ? parsed.items : [];

  const finalItems: ParsedBillItem[] = rawItems
    .map((it: any) => {
      const rawParticulars = String(it.raw_particulars || it.particulars || it.name || '').trim();
      const localMatch = matchToMasterItem(rawParticulars, catalog);

      const qty = Number(it.qty_or_kg ?? it.qty ?? 0);
      const rate = Number(it.unit_rate ?? it.rate ?? 0);
      const val = Number(it.total_value ?? it.value ?? Number((qty * rate).toFixed(2)));

      return {
        hsn_code: String(it.hsn_code || '').trim(),
        raw_particulars: rawParticulars,
        matched_item_name: localMatch.id ? localMatch.name : rawParticulars,
        master_item_id: localMatch.id,
        qty_or_kg: qty,
        unit_rate: rate,
        total_value: val
      };
    })
    .filter((it: ParsedBillItem) => it.raw_particulars.length > 0 && it.total_value > 0);

  const totalAmount = Number(finalItems.reduce((acc, it) => acc + it.total_value, 0).toFixed(2));
  const totalQty = Number(finalItems.reduce((acc, it) => acc + it.qty_or_kg, 0).toFixed(3));
  const billDate =
    parsed?.bill_date && /^\d{4}-\d{2}-\d{2}$/.test(String(parsed.bill_date))
      ? String(parsed.bill_date)
      : new Date().toISOString().slice(0, 10);

  return {
    store_name: String(parsed?.store_name || 'DMart').trim(),
    bill_date: billDate,
    month_year: billDate.slice(0, 7),
    bill_number: String(parsed?.bill_number || '').trim(),
    total_items_count: finalItems.length,
    total_qty_count: totalQty,
    total_amount: totalAmount,
    total_savings: Number(parsed?.total_savings) || 0,
    items: finalItems
  };
}

const COMPACT_RECEIPT_PROMPT = `Extract all purchased line items and header details from this receipt image into JSON.
Ignore tax summary headers (CGST/SGST slabs) and footer totals.
Return ONLY valid JSON matching this schema:
{
  "store_name": "string",
  "bill_date": "YYYY-MM-DD",
  "bill_number": "string",
  "total_savings": number,
  "items": [
    {
      "hsn_code": "string",
      "raw_particulars": "string",
      "qty_or_kg": number,
      "unit_rate": number,
      "total_value": number
    }
  ]
}`;

// 3A. Fast Groq Vision Engine (Zero 503s if VITE_GROQ_API_KEY is in .env)
async function extractWithGroqVision(
  file: File,
  catalog: MasterItem[],
  groqKey: string,
  onProgress?: (pct: number) => void
): Promise<ParsedBill> {
  if (onProgress) onProgress(25);
  const { dataUrl } = await compressImageToBase64(file, 1280);
  if (onProgress) onProgress(55);

  const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${groqKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: 'meta-llama/llama-4-scout-17b-16e-instruct',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: COMPACT_RECEIPT_PROMPT },
            { type: 'image_url', image_url: { url: dataUrl } }
          ]
        }
      ],
      response_format: { type: 'json_object' },
      temperature: 0.0
    })
  });

  if (!response.ok) {
    throw new Error(`Groq Vision HTTP ${response.status}: ${await response.text()}`);
  }

  if (onProgress) onProgress(90);
  const data = await response.json();
  const content = data.choices?.[0]?.message?.content || '{}';
  const parsed = JSON.parse(content);
  if (onProgress) onProgress(100);

  return normalizeVisionJsonToBill(parsed, catalog);
}

// 3B. Lightweight Gemini Vision Engine (Filtered model discovery + compact payload)
async function extractWithGeminiVision(
  file: File,
  catalog: MasterItem[],
  apiKey: string,
  onProgress?: (pct: number) => void
): Promise<ParsedBill> {
  if (onProgress) onProgress(20);
  const { base64, mimeType } = await compressImageToBase64(file, 1024);

  let candidateModels = ['gemini-3.8-flash'];
  try {
    const listRes = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`);
    if (listRes.ok) {
      const listData = await listRes.json();
      const discovered = (listData.models || [])
        .filter((m: any) => m.supportedGenerationMethods?.includes('generateContent'))
        .map((m: any) => String(m.name).replace(/^models\//, ''))
        .filter(
          (name: string) =>
            name.startsWith('gemini-') &&
            !name.includes('2.5') &&
            !name.includes('2.0') &&
            !name.includes('1.5') &&
            !name.includes('tts') &&
            !name.includes('audio') &&
            !name.includes('embedding') &&
            !name.includes('imagen')
        );
      if (discovered.length > 0) {
        candidateModels = discovered;
      }
    }
  } catch {
    // Keep default candidateModels
  }

  let lastErrorMsg = 'Gemini Vision service is currently unavailable (503).';

  for (let i = 0; i < candidateModels.length; i++) {
    const modelName = candidateModels[i];

    for (let attempt = 1; attempt <= 2; attempt++) {
      if (onProgress) onProgress(Math.min(85, 35 + i * 15 + attempt * 10));

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 15000);

      try {
        const response = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${apiKey}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            signal: controller.signal,
            body: JSON.stringify({
              contents: [
                {
                  parts: [
                    { text: COMPACT_RECEIPT_PROMPT },
                    { inline_data: { mime_type: mimeType, data: base64 } }
                  ]
                }
              ],
              generationConfig: {
                response_mime_type: 'application/json',
                temperature: 0.0
              }
            })
          }
        );
        clearTimeout(timeoutId);

        if (response.ok) {
          const data = await response.json();
          const rawJsonText = data.candidates?.[0]?.content?.parts?.[0]?.text || '{}';
          const parsed = JSON.parse(rawJsonText);
          if (parsed && Array.isArray(parsed.items) && parsed.items.length > 0) {
            if (onProgress) onProgress(100);
            return normalizeVisionJsonToBill(parsed, catalog);
          }
        } else {
          const errBody = await response.text();
          lastErrorMsg = `${modelName} (${response.status}): ${errBody}`;
          if (response.status === 503 || response.status === 429) {
            await new Promise(r => setTimeout(r, 2000));
            continue;
          }
          break;
        }
      } catch (e: any) {
        clearTimeout(timeoutId);
        lastErrorMsg = e?.name === 'AbortError' ? `${modelName} timed out` : String(e?.message || e);
      }
    }
  }

  throw new Error(lastErrorMsg);
}

// 4. Generalized Spatial Row Parser (For Capacitor ML Kit 2D Bounding Boxes or Raw OCR Lines)
export function parseSpatialBlocksToDMartBill(
  linesWithBoxes: Array<{ text: string; top: number; left: number; height: number }>,
  catalog: MasterItem[],
  fullRawText = ''
): ParsedBill {
  const sorted = [...linesWithBoxes].sort((a, b) => a.top - b.top);
  const reconstructedRows: Array<Array<{ text: string; left: number }>> = [];
  let currentGroup: Array<{ text: string; top: number; left: number; height: number }> = [];

  for (const fragment of sorted) {
    if (currentGroup.length === 0) {
      currentGroup.push(fragment);
    } else {
      const avgTop = currentGroup.reduce((sum, f) => sum + f.top, 0) / currentGroup.length;
      const tolerance = Math.max(fragment.height * 0.65, 14);
      if (Math.abs(fragment.top - avgTop) <= tolerance) {
        currentGroup.push(fragment);
      } else {
        reconstructedRows.push(currentGroup.sort((a, b) => a.left - b.left));
        currentGroup = [fragment];
      }
    }
  }
  if (currentGroup.length > 0) {
    reconstructedRows.push(currentGroup.sort((a, b) => a.left - b.left));
  }

  const joinedLines = reconstructedRows.map(row => row.map(r => r.text.trim()).join('  '));
  const combinedText = fullRawText || joinedLines.join('\n');

  let billDate = new Date().toISOString().slice(0, 10);
  let billNumber = '';
  let totalSavings = 0;

  const dateMatch = combinedText.match(/(\d{2})[\/\-](\d{2})[\/\-](20\d{2})/);
  if (dateMatch) {
    billDate = `${dateMatch[3]}-${dateMatch[2]}-${dateMatch[1]}`;
  }

  const billNoMatch = combinedText.match(/Bill\s*No\s*[:\-]?\s*([A-Z0-9\-]+)/i);
  if (billNoMatch) {
    billNumber = billNoMatch[1];
  }

  const savingsMatch = combinedText.match(/Saved\s*Rs\.?\s*(\d+(?:[\.,]\d{1,2})?)/i);
  if (savingsMatch) {
    totalSavings = parseFloat(savingsMatch[1].replace(',', '.')) || 0;
  }

  const items: ParsedBillItem[] = [];
  const rowRegex =
    /^([0-9OIl]{3,8})?\s*([A-Z0-9\s\-\.&\/]+?)\s+(\d+(?:[\.,:]\d{1,3})?)\s+(\d+[\.,:]\d{2})\s+(\d+[\.,:]\d{2})$/i;

  for (const line of joinedLines) {
    if (/CGST|SGST|Taxable|Breakup|Items:|Saved|Total|Amount/i.test(line)) continue;
    const match = line.match(rowRegex);
    if (match) {
      const hsn = (match[1] || '').replace(/O/gi, '0').replace(/[Il]/g, '1').trim();
      const rawName = match[2].trim();
      const qty = parseFloat(match[3].replace(/[,:]/g, '.'));
      const rate = parseFloat(match[4].replace(/[,:]/g, '.'));
      const val = parseFloat(match[5].replace(/[,:]/g, '.'));

      if (qty > 0 && rate > 0 && val > 0 && rawName.length >= 2) {
        const matched = matchToMasterItem(rawName, catalog);
        items.push({
          hsn_code: hsn,
          raw_particulars: rawName,
          matched_item_name: matched.name,
          master_item_id: matched.id,
          qty_or_kg: qty,
          unit_rate: rate,
          total_value: val
        });
      }
    }
  }

  return {
    store_name: 'DMart',
    bill_date: billDate,
    month_year: billDate.slice(0, 7),
    bill_number: billNumber,
    total_items_count: items.length,
    total_qty_count: Number(items.reduce((s, i) => s + i.qty_or_kg, 0).toFixed(3)),
    total_amount: Number(items.reduce((s, i) => s + i.total_value, 0).toFixed(2)),
    total_savings: totalSavings,
    items
  };
}

// 5. Main Entry Point Called by App.tsx
export async function extractDMartBillFromImage(
  file: File,
  catalog: MasterItem[],
  onProgress?: (pct: number) => void
): Promise<ParsedBill> {
  const groqKey = import.meta.env.VITE_GROQ_API_KEY;
  const geminiKey = import.meta.env.VITE_GEMINI_API_KEY;

  // Priority 1: Groq Llama-4 Vision (if configured in .env)
  if (groqKey && groqKey.trim().length > 10) {
    try {
      return await extractWithGroqVision(file, catalog, groqKey.trim(), onProgress);
    } catch (err) {
      console.warn('Groq Vision failed, trying next engine:', err);
    }
  }

  // Priority 2: Gemini Vision (if configured in .env)
  if (geminiKey && geminiKey.trim().length > 10) {
    try {
      return await extractWithGeminiVision(file, catalog, geminiKey.trim(), onProgress);
    } catch (err) {
      console.warn('Gemini Vision unavailable, falling back to on-device OCR:', err);
    }
  }

  // Priority 3: Native Android ML Kit Text Recognition v8 (Runs 100% offline on Android NPU/GPU)
  if (Capacitor.isNativePlatform()) {
    try {
      if (onProgress) onProgress(25);
      const { base64 } = await compressImageToBase64(file, 1600);

      const tempFileName = `receipt_${Date.now()}.jpg`;
      const savedFile = await Filesystem.writeFile({
        path: tempFileName,
        data: base64,
        directory: Directory.Cache
      });

      if (onProgress) onProgress(60);
      const mlResult = await TextRecognition.processImage({
        path: savedFile.uri,
        script: Script.Latin
      });

      await Filesystem.deleteFile({
        path: tempFileName,
        directory: Directory.Cache
      }).catch(() => {});

      if (onProgress) onProgress(95);

      const linesWithBoxes = (mlResult.blocks || []).flatMap(b =>
        (b.lines || []).map((l: any) => {
          const pts = l.cornerPoints;
          const top = pts?.[0]?.[1] ?? pts?.[0]?.y ?? l.rect?.top ?? 0;
          const left = pts?.[0]?.[0] ?? pts?.[0]?.x ?? l.rect?.left ?? 0;
          const bottom = pts?.[2]?.[1] ?? pts?.[2]?.y ?? l.rect?.bottom ?? top + 20;
          return {
            text: String(l.text || ''),
            top,
            left,
            height: Math.max(10, Math.abs(bottom - top))
          };
        })
      );

      if (onProgress) onProgress(100);
      return parseSpatialBlocksToDMartBill(linesWithBoxes, catalog, mlResult.text || '');
    } catch (mlErr) {
      console.warn('Native ML Kit failed, falling back to Tesseract:', mlErr);
    }
  }

  // Priority 4: Browser Tesseract.js Fallback
  const result = await Tesseract.recognize(file, 'eng', {
    logger: m => {
      if (m.status === 'recognizing text' && onProgress) {
        onProgress(Math.round(m.progress * 100));
      }
    }
  });

  const rawText = result.data.text || '';
  const lines = rawText.split('\n').map(l => l.trim()).filter(Boolean);
  const linesWithBoxes = lines.map((text, idx) => ({ text, top: idx * 30, left: 0, height: 20 }));

  return parseSpatialBlocksToDMartBill(linesWithBoxes, catalog, rawText);
}