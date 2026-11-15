import React, { useState, useEffect, useMemo } from 'react';
import { supabase } from './supabaseClient';
import {
  extractDMartBillFromImage,
  type MasterItem,
  type ParsedBill
} from './dmartParser';

interface ShoppingListItem {
  id: string;
  master_item_id: string | null;
  item_name: string;
  category: string;
  sub_category?: string;
  qty: number;
  unit: string;
  is_checked: boolean;
  month_year: string;
}

interface SavedBill {
  id: string;
  store_name: string;
  bill_date: string;
  month_year: string;
  bill_number: string;
  total_items_count: number;
  total_qty_count: number;
  total_amount: number;
  total_savings: number;
  created_at?: string;
}

// Smart Self-Learning Auto-Categorizer: Infers Category, Sub-Category, Unit & Clean Name
// from DMart HSN codes + raw receipt text whenever a brand-new product is scanned!
function inferCategoryAndSubCategory(
  hsnCode: string = '',
  rawParticulars: string = '',
  matchedName: string = ''
): { category: string; sub_category: string; default_unit: string; default_qty: number; clean_name: string } {
  const hsn = (hsnCode || '').trim();
  const text = `${rawParticulars} ${matchedName}`.toUpperCase();

  // Extract unit & qty from raw receipt text (e.g. "-500g", "-1kg", "-300ml", "-1lt")
  let default_unit = 'pcs';
  let default_qty = 1;
  const weightMatch = text.match(/(\d+(?:\.\d+)?)\s*(KG|GM|G|ML|LT|L|NOS|PC|PCS)\b/i);
  if (weightMatch) {
    const val = parseFloat(weightMatch[1]) || 1;
    const u = weightMatch[2].toUpperCase();
    if (u === 'G' || u === 'GM') {
      default_unit = 'gm';
      default_qty = val;
    } else if (u === 'KG') {
      default_unit = 'kg';
      default_qty = val;
    } else if (u === 'ML') {
      default_unit = 'ml';
      default_qty = val;
    } else if (u === 'L' || u === 'LT') {
      default_unit = 'L';
      default_qty = val;
    } else {
      default_unit = 'pcs';
      default_qty = val;
    }
  }

  // Clean up raw receipt name if it wasn't matched to an existing generic name
  let clean_name = matchedName.trim();
  if (!clean_name || clean_name.toUpperCase() === rawParticulars.trim().toUpperCase()) {
    clean_name = rawParticulars
      .replace(/[-–]\s*\d+\s*(kg|gm|g|ml|lt|l|nos|pc|pcs)\b/gi, '')
      .replace(/\b\d+\s*(kg|gm|g|ml|lt|l|nos|pc|pcs)\b/gi, '')
      .replace(/^L\s+/i, '') // Strip DMart 'L ' (Loose) prefix
      .trim()
      .toLowerCase()
      .replace(/\b\w/g, ch => ch.toUpperCase());
  }

  // 1. Keyword-based Category + Sub-Category detection
  if (/\b(DAL|MOONG|TOOR|CHANA|MASOOR|URAD|RAJMA|MATKI|CHAWLI|WATANA|SOYA)\b/.test(text)) {
    return { category: 'Grocery', sub_category: 'Dals & Pulses', default_unit: default_unit === 'pcs' ? 'kg' : default_unit, default_qty, clean_name };
  }
  if (/\b(ATTA|MAIDA|RAWA|SOOJI|BESAN|FLOUR|BHAGAR|SABUDANA)\b/.test(text)) {
    return { category: 'Grocery', sub_category: 'Flours & Grains', default_unit: default_unit === 'pcs' ? 'kg' : default_unit, default_qty, clean_name };
  }
  if (/\b(RICE|POHA|MURMURA|BASMATI|KOLAM|INDRAYANI)\b/.test(text)) {
    return { category: 'Grocery', sub_category: 'Rice & Rice Products', default_unit: default_unit === 'pcs' ? 'kg' : default_unit, default_qty, clean_name };
  }
  if (/\b(OIL|SOYABEAN|SUNFLOWER|GROUNDNUT OIL|GHEE|VANASPATI)\b/.test(text)) {
    return { category: 'Grocery', sub_category: 'Cooking Oil & Ghee', default_unit: default_unit === 'pcs' ? 'L' : default_unit, default_qty, clean_name };
  }
  if (/\b(BADAM|ALMOND|KAJU|CASHEW|KISHMISH|PISTA|WALNUT|GROUNDNUT|PEANUT|DRY CO|KHOPRA|DATES|KHAJOOR)\b/.test(text)) {
    return { category: 'Grocery', sub_category: 'Dry Fruits', default_unit: default_unit === 'pcs' ? 'gm' : default_unit, default_qty, clean_name };
  }
  if (/\b(MASALA|SPICE|JEERA|AJWA|HALDI|CHILLI|MIRCHI|HING|DHANIYA|GARAM)\b/.test(text)) {
    return { category: 'Grocery', sub_category: 'Masala & Spices', default_unit: default_unit === 'pcs' ? 'gm' : default_unit, default_qty, clean_name };
  }
  if (/\b(SALT|SUGAR|JAGGERY|GUD)\b/.test(text)) {
    return { category: 'Grocery', sub_category: 'Salt / Sugar / Jaggery', default_unit: default_unit === 'pcs' ? 'kg' : default_unit, default_qty, clean_name };
  }
  if (/\b(TEA|COFFEE|CHAI|BOURNVITA|HORLICKS|MILK|PANEER|BUTTER|CHEESE|CURD)\b/.test(text)) {
    return { category: 'Dairy & Beverages', sub_category: 'Tea, Coffee & Dairy', default_unit, default_qty, clean_name };
  }
  if (/\b(BISCUIT|COOKIE|MAGGI|NOODLE|YIPPE|PASTA|KETCHUP|SAUCE|CHOCOLATE|MILKYBAR|IMLI|CANDY|NAMKEEN|CHIPS|POPCORN|PAPAD|PICKLE)\b/.test(text)) {
    return { category: 'Packaged Food', sub_category: 'Snacks & Packaged Food', default_unit, default_qty, clean_name };
  }
  if (/\b(SOAP|SHAMPOO|LOTION|CREAM|TOOTHPASTE|BRUSH|FACE|HAIR|UBTAN|UTANE|TALC|DEO|PAD|SHAVING)\b/.test(text)) {
    return { category: 'Personal Care', sub_category: 'Skin, Hair & Oral Care', default_unit, default_qty, clean_name };
  }
  if (/\b(BROOM|JHADU|MOP|CLEANER|DRAINIT|HARPIC|LIZOL|PHENYL|DETERGENT|SURF|WHEEL|RIN|VIM|EXO|ODONIL|AGARBATTI|DHOOP|BRASS|PITAMBARI)\b/.test(text)) {
    return { category: 'Home & Kitchen', sub_category: 'Cleaners & Household', default_unit, default_qty, clean_name };
  }
  if (/\b(VEST|TRUNK|BRIEF|SOCKS|TOWEL|BEDSHEET|APPAREL|SHIRT|PANT)\b/.test(text)) {
    return { category: 'Clothing & Accessories', sub_category: 'Innerwear & Apparel', default_unit: 'pcs', default_qty, clean_name };
  }
  if (/\b(BULB|LED|EMERGEN|IRON|MIXER|KETTLE|APPLIANCE|BATTERY)\b/.test(text)) {
    return { category: 'Appliances', sub_category: 'Electricals & Appliances', default_unit: 'pcs', default_qty, clean_name };
  }

  // 2. Fallback to DMart HSN Code Prefix
  if (/^(07|08|09|10|11|12|15|17|25)/.test(hsn)) {
    return { category: 'Grocery', sub_category: 'Staples & Grocery', default_unit, default_qty, clean_name };
  }
  if (/^(18|19|20|21|22)/.test(hsn)) {
    return { category: 'Packaged Food', sub_category: 'Snacks & Packaged Food', default_unit, default_qty, clean_name };
  }
  if (/^(33)/.test(hsn)) {
    return { category: 'Personal Care', sub_category: 'Personal Care', default_unit, default_qty, clean_name };
  }
  if (/^(34|38|39|73|96)/.test(hsn)) {
    return { category: 'Home & Kitchen', sub_category: 'Home & Cleaning', default_unit, default_qty, clean_name };
  }
  if (/^(61|62|63)/.test(hsn)) {
    return { category: 'Clothing & Accessories', sub_category: 'Innerwear & Apparel', default_unit: 'pcs', default_qty, clean_name };
  }
  if (/^(84|85)/.test(hsn)) {
    return { category: 'Appliances', sub_category: 'Electricals & Appliances', default_unit: 'pcs', default_qty, clean_name };
  }

  return { category: 'Grocery', sub_category: 'General', default_unit, default_qty, clean_name };
}

// Helper to normalize any OCR date (like "29/10/2026" or "2026-10-29") into strict YYYY-MM-DD and YYYY-MM
function normalizeBillDateAndMonth(rawDate?: string, rawMonth?: string, fallbackMonth?: string) {
  const today = new Date().toISOString().slice(0, 10);
  let bill_date = (rawDate || '').trim();

  // Convert DD/MM/YYYY or DD-MM-YYYY to YYYY-MM-DD
  const dmyMatch = bill_date.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})/);
  if (dmyMatch) {
    const dd = dmyMatch[1].padStart(2, '0');
    const mm = dmyMatch[2].padStart(2, '0');
    const yyyy = dmyMatch[3];
    bill_date = `${yyyy}-${mm}-${dd}`;
  } else if (!/^\d{4}-\d{2}-\d{2}$/.test(bill_date)) {
    bill_date = today;
  }

  let month_year = (rawMonth || '').trim();
  if (!/^\d{4}-\d{2}$/.test(month_year)) {
    month_year = bill_date.slice(0, 7) || fallbackMonth || today.slice(0, 7);
  }

  return { bill_date, month_year };
}

export default function App() {
  const [activeTab, setActiveTab] = useState<'select' | 'list' | 'scan' | 'history'>('select');
  const [selectedMonth, setSelectedMonth] = useState<string>(() => new Date().toISOString().slice(0, 7));
  const [showAllMonthsHistory, setShowAllMonthsHistory] = useState<boolean>(true);

  const [catalog, setCatalog] = useState<MasterItem[]>([]);
  const [loadingCatalog, setLoadingCatalog] = useState<boolean>(true);

  const [searchQuery, setSearchQuery] = useState<string>('');
  const [selectedCategory, setSelectedCategory] = useState<string>('All');
  const [selectedSubCategory, setSelectedSubCategory] = useState<string>('All');
  const [visibleLimit, setVisibleLimit] = useState<number>(80);

  const [showAddCustomModal, setShowAddCustomModal] = useState<boolean>(false);
  const [customItemName, setCustomItemName] = useState<string>('');
  const [customItemCat, setCustomItemCat] = useState<string>('Grocery');
  const [customItemSubCat, setCustomItemSubCat] = useState<string>('General');
  const [customItemQty, setCustomItemQty] = useState<number>(1);
  const [customItemUnit, setCustomItemUnit] = useState<string>('kg');

  const [shoppingList, setShoppingList] = useState<ShoppingListItem[]>([]);
  const [loadingList, setLoadingList] = useState<boolean>(false);

  const [scanning, setScanning] = useState<boolean>(false);
  const [scanProgress, setScanProgress] = useState<number>(0);
  const [scanError, setScanError] = useState<string | null>(null);
  const [draftBill, setDraftBill] = useState<ParsedBill | null>(null);
  const [savingBill, setSavingBill] = useState<boolean>(false);

  const [savedBills, setSavedBills] = useState<SavedBill[]>([]);
  const [selectedHistoryBillItems, setSelectedHistoryBillItems] = useState<any[] | null>(null);
  const [activeHistoryBillId, setActiveHistoryBillId] = useState<string | null>(null);

  const [toast, setToast] = useState<string | null>(null);

  const showToast = (msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(null), 3500);
  };

  const fetchMasterCatalog = async () => {
    setLoadingCatalog(true);
    try {
      let allItems: MasterItem[] = [];
      let from = 0;
      const step = 1000;

      while (true) {
        const { data, error } = await supabase
          .from('master_items')
          .select('*')
          .order('name', { ascending: true })
          .range(from, from + step - 1);

        if (error) throw error;
        if (!data || data.length === 0) break;

        allItems = [...allItems, ...(data as MasterItem[])];
        if (data.length < step) break;
        from += step;
      }

      setCatalog(allItems);
    } catch (err: any) {
      console.error('Error loading master catalog:', err.message);
      showToast('Failed to load catalog from Supabase');
    } finally {
      setLoadingCatalog(false);
    }
  };

  const fetchShoppingList = async (month: string) => {
    setLoadingList(true);
    try {
      const { data, error } = await supabase
        .from('shopping_list')
        .select('*')
        .eq('month_year', month)
        .order('category', { ascending: true });

      if (!error && data) {
        setShoppingList(data as ShoppingListItem[]);
      }
    } catch (err) {
      console.warn('Shopping list fetch warning:', err);
    } finally {
      setLoadingList(false);
    }
  };

  const fetchBillsHistory = async (month: string, allMonths: boolean = showAllMonthsHistory) => {
    try {
      let query = supabase.from('bills').select('*').order('created_at', { ascending: false });
      if (!allMonths) {
        query = query.eq('month_year', month);
      }
      const { data, error } = await query;

      if (error) {
        console.error('Error fetching bills:', error.message);
      } else if (data) {
        setSavedBills(data as SavedBill[]);
      }
    } catch (err) {
      console.warn('Bills fetch warning:', err);
    }
  };

  useEffect(() => {
    fetchMasterCatalog();
  }, []);

  useEffect(() => {
    fetchShoppingList(selectedMonth);
    fetchBillsHistory(selectedMonth, showAllMonthsHistory);
  }, [selectedMonth, showAllMonthsHistory]);

  useEffect(() => {
    setVisibleLimit(80);
  }, [selectedCategory, selectedSubCategory, searchQuery]);

  const formatSubCategoryLabel = (sub?: string) => {
    if (!sub || sub === 'General') return 'General';
    return sub.includes('/') ? sub.split('/').pop()!.trim() : sub;
  };

  const categories = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const item of catalog) {
      const cat = item.category || 'General';
      counts[cat] = (counts[cat] || 0) + 1;
    }
    const sortedCats = Object.keys(counts).sort((a, b) => counts[b] - counts[a]);
    return ['All', ...sortedCats];
  }, [catalog]);

  const subCategories = useMemo(() => {
    const baseList =
      selectedCategory === 'All'
        ? catalog
        : catalog.filter(item => (item.category || 'General') === selectedCategory);

    const counts: Record<string, number> = {};
    for (const item of baseList) {
      const sub = item.sub_category || 'General';
      counts[sub] = (counts[sub] || 0) + 1;
    }
    const sortedSubs = Object.keys(counts).sort((a, b) => counts[b] - counts[a]);
    return ['All', ...sortedSubs];
  }, [catalog, selectedCategory]);

  const filteredCatalog = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    const escaped = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const wordStartRegex = q ? new RegExp(`(^|[\\s(/,-])${escaped}`, 'i') : null;

    return catalog.filter(item => {
      const itemCat = item.category || 'General';
      const itemSub = item.sub_category || 'General';

      const matchesCat = selectedCategory === 'All' || itemCat === selectedCategory;
      const matchesSub = selectedSubCategory === 'All' || itemSub === selectedSubCategory;
      const matchesSearch =
        !wordStartRegex ||
        wordStartRegex.test(item.name) ||
        wordStartRegex.test(itemCat) ||
        wordStartRegex.test(itemSub);

      return matchesCat && matchesSub && matchesSearch;
    });
  }, [catalog, selectedCategory, selectedSubCategory, searchQuery]);

  const selectedMap = useMemo(() => {
    const map = new Map<string, ShoppingListItem>();
    for (const li of shoppingList) {
      map.set(li.item_name.toLowerCase(), li);
    }
    return map;
  }, [shoppingList]);

  const handleToggleCatalogItem = async (item: MasterItem) => {
    const existing = selectedMap.get(item.name.toLowerCase());

    if (existing) {
      setShoppingList(prev => prev.filter(i => i.id !== existing.id));
      await supabase.from('shopping_list').delete().eq('id', existing.id);
      showToast(`Removed ${item.name}`);
    } else {
      const newEntry = {
        master_item_id: item.id,
        item_name: item.name,
        category: item.category || 'General',
        qty: item.default_qty || 1,
        unit: item.default_unit || 'kg',
        is_checked: false,
        month_year: selectedMonth
      };

      const { data, error } = await supabase
        .from('shopping_list')
        .insert([newEntry])
        .select()
        .single();

      if (!error && data) {
        setShoppingList(prev => [...prev, data as ShoppingListItem]);
        showToast(`Added ${item.name} to list`);
      } else {
        setShoppingList(prev => [
          ...prev,
          { ...newEntry, id: `local_${Date.now()}` } as ShoppingListItem
        ]);
        showToast(`Added ${item.name}`);
      }
    }
  };

  const handleUpdateShoppingItem = async (id: string, qty: number, unit: string) => {
    if (qty <= 0) return;
    setShoppingList(prev => prev.map(it => (it.id === id ? { ...it, qty, unit } : it)));
    await supabase.from('shopping_list').update({ qty, unit }).eq('id', id);
  };

  const handleToggleChecked = async (item: ShoppingListItem) => {
    const nextState = !item.is_checked;
    setShoppingList(prev =>
      prev.map(it => (it.id === item.id ? { ...it, is_checked: nextState } : it))
    );
    await supabase.from('shopping_list').update({ is_checked: nextState }).eq('id', item.id);
  };

  const handleDeleteShoppingItem = async (id: string) => {
    setShoppingList(prev => prev.filter(it => it.id !== id));
    await supabase.from('shopping_list').delete().eq('id', id);
  };

  const handleClearCheckedItems = async () => {
    const checkedIds = shoppingList.filter(i => i.is_checked).map(i => i.id);
    if (checkedIds.length === 0) return;
    if (!window.confirm(`Remove ${checkedIds.length} bought items from this list?`)) return;

    setShoppingList(prev => prev.filter(i => !i.is_checked));
    await supabase.from('shopping_list').delete().in('id', checkedIds);
    showToast(`Cleared ${checkedIds.length} checked items`);
  };

  const handleClearEntireList = async () => {
    if (shoppingList.length === 0) return;
    if (!window.confirm(`Delete ALL ${shoppingList.length} items from ${selectedMonth}?`)) return;

    setShoppingList([]);
    await supabase.from('shopping_list').delete().eq('month_year', selectedMonth);
    showToast(`Cleared entire list for ${selectedMonth}`);
  };

  const handleCopyPreviousMonthList = async () => {
    const [year, month] = selectedMonth.split('-').map(Number);
    const prevDate = new Date(year, month - 2, 1);
    const prevMonthStr = `${prevDate.getFullYear()}-${String(prevDate.getMonth() + 1).padStart(2, '0')}`;

    const { data, error } = await supabase
      .from('shopping_list')
      .select('*')
      .eq('month_year', prevMonthStr);

    if (error || !data || data.length === 0) {
      showToast(`No saved list found for ${prevMonthStr}`);
      return;
    }

    const existingNames = new Set(shoppingList.map(i => i.item_name.toLowerCase()));
    const newItemsToInsert = data
      .filter((item: any) => !existingNames.has(item.item_name.toLowerCase()))
      .map((item: any) => ({
        master_item_id: item.master_item_id,
        item_name: item.item_name,
        category: item.category,
        qty: item.qty,
        unit: item.unit,
        is_checked: false,
        month_year: selectedMonth
      }));

    if (newItemsToInsert.length === 0) {
      showToast('All items from last month are already in this list!');
      return;
    }

    const { data: inserted, error: insertErr } = await supabase
      .from('shopping_list')
      .insert(newItemsToInsert)
      .select();

    if (!insertErr && inserted) {
      setShoppingList(prev => [...prev, ...(inserted as ShoppingListItem[])]);
      showToast(`Copied ${inserted.length} items from ${prevMonthStr}!`);
    }
  };

  const handleAddCustomMasterItem = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!customItemName.trim()) return;

    const payload = {
      name: customItemName.trim(),
      category: customItemCat.trim() || 'Grocery',
      sub_category: customItemSubCat.trim() || 'General',
      default_qty: Number(customItemQty) || 1,
      default_unit: customItemUnit || 'kg',
      dmart_aliases: [customItemName.trim().toUpperCase()]
    };

    const { data, error } = await supabase
      .from('master_items')
      .upsert(payload, { onConflict: 'name' })
      .select()
      .single();

    if (!error && data) {
      const added = data as MasterItem;
      setCatalog(prev => [added, ...prev]);
      await handleToggleCatalogItem(added);
      setCustomItemName('');
      setShowAddCustomModal(false);
    } else {
      showToast(`Error adding item: ${error?.message || 'Unknown error'}`);
    }
  };

  const handleReceiptUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setScanning(true);
    setScanProgress(10);
    setScanError(null);
    setDraftBill(null);

    try {
      const parsed = await extractDMartBillFromImage(file, catalog, pct => {
        setScanProgress(pct);
      });

      // Normalize date & pre-populate clean generic names for any unmatched items
      const { bill_date, month_year } = normalizeBillDateAndMonth(
        parsed.bill_date,
        parsed.month_year,
        selectedMonth
      );

      const enrichedItems = parsed.items.map(it => {
        const existingMaster = catalog.find(
          c =>
            c.name.toLowerCase() === (it.matched_item_name || '').toLowerCase() ||
            c.dmart_aliases?.some(a => a.toUpperCase() === (it.raw_particulars || '').toUpperCase())
        );

        if (existingMaster) {
          return {
            ...it,
            matched_item_name: existingMaster.name,
            master_item_id: existingMaster.id
          };
        }

        const inferred = inferCategoryAndSubCategory(
          it.hsn_code,
          it.raw_particulars,
          it.matched_item_name
        );
        return {
          ...it,
          matched_item_name: inferred.clean_name
        };
      });

      setDraftBill({
        ...parsed,
        bill_date,
        month_year,
        items: enrichedItems
      });
    } catch (err: any) {
      console.error('Receipt scan failed:', err);
      setScanError(err?.message || 'Failed to scan receipt. Please try a clearer photo.');
    } finally {
      setScanning(false);
    }
  };

  // Update a draft bill item's matched generic name before saving
  const handleDraftItemNameChange = (idx: number, newName: string) => {
    if (!draftBill) return;
    const updated = [...draftBill.items];
    updated[idx] = { ...updated[idx], matched_item_name: newName };
    setDraftBill({ ...draftBill, items: updated });
  };

  // FULL SELF-LEARNING + BILL SAVING ENGINE
  const saveVerifiedBillToDb = async () => {
    if (!draftBill) return;
    setSavingBill(true);

    try {
      const { bill_date, month_year } = normalizeBillDateAndMonth(
        draftBill.bill_date,
        draftBill.month_year,
        selectedMonth
      );

      let newItemsCreatedCount = 0;
      let aliasesLearnedCount = 0;
      const updatedItemsWithIds = [...draftBill.items];

      // 1. SELF-LEARNING CATALOG ENGINE:
      //    - If matched item exists in catalog -> append raw_particulars to its dmart_aliases
      //    - If matched item is NEW -> auto-infer Category & Sub-Category and INSERT into master_items!
      for (let i = 0; i < updatedItemsWithIds.length; i++) {
        const it = updatedItemsWithIds[i];
        const rawAlias = (it.raw_particulars || '').trim().toUpperCase();
        const targetName = (it.matched_item_name || it.raw_particulars || 'Unknown Item').trim();

        const existingMaster = catalog.find(
          c =>
            c.name.toLowerCase() === targetName.toLowerCase() ||
            (rawAlias && c.dmart_aliases?.some(a => a.toUpperCase() === rawAlias))
        );

        if (existingMaster) {
          updatedItemsWithIds[i].master_item_id = existingMaster.id;
          updatedItemsWithIds[i].matched_item_name = existingMaster.name;

          const currentAliases = existingMaster.dmart_aliases || [];
          const hasAlias = currentAliases.some(a => a.toUpperCase() === rawAlias);

          if (rawAlias && !hasAlias) {
            const nextAliases = [...currentAliases, rawAlias];
            const { error: aliasErr } = await supabase
              .from('master_items')
              .update({ dmart_aliases: nextAliases })
              .eq('id', existingMaster.id);

            if (!aliasErr) {
              aliasesLearnedCount++;
              existingMaster.dmart_aliases = nextAliases;
            }
          }
        } else {
          // Brand-new product not in catalog! Auto-create Category & Sub-Category!
          const inferred = inferCategoryAndSubCategory(
            it.hsn_code,
            it.raw_particulars,
            targetName
          );
          const finalName = targetName || inferred.clean_name;
          const aliases = Array.from(
            new Set([finalName.toUpperCase(), ...(rawAlias ? [rawAlias] : [])])
          );

          const { data: newMaster, error: createErr } = await supabase
            .from('master_items')
            .upsert(
              {
                name: finalName,
                category: inferred.category,
                sub_category: inferred.sub_category,
                default_qty: inferred.default_qty,
                default_unit: inferred.default_unit,
                dmart_aliases: aliases
              },
              { onConflict: 'name' }
            )
            .select()
            .single();

          if (!createErr && newMaster) {
            newItemsCreatedCount++;
            updatedItemsWithIds[i].master_item_id = newMaster.id;
            updatedItemsWithIds[i].matched_item_name = newMaster.name;
            catalog.push(newMaster as MasterItem);
          } else if (createErr) {
            console.warn('Could not auto-create master item:', createErr.message);
          }
        }
      }

      // 2. SAVE BILL HEADER TO `bills` TABLE
      const billPayload = {
        store_name: draftBill.store_name || 'DMart',
        bill_date,
        month_year,
        bill_number: draftBill.bill_number || `BILL-${Date.now()}`,
        total_items_count: updatedItemsWithIds.length,
        total_qty_count: Number(draftBill.total_qty_count) || updatedItemsWithIds.length,
        total_amount: Number(draftBill.total_amount) || 0,
        total_savings: Number(draftBill.total_savings) || 0
      };

      const { data: billData, error: billErr } = await supabase
        .from('bills')
        .insert([billPayload])
        .select()
        .single();

      if (billErr) {
        throw new Error(`Bills table error: ${billErr.message}`);
      }

      // 3. SAVE LINE ITEMS TO `bill_items` TABLE
      if (billData && updatedItemsWithIds.length > 0) {
        const linePayloads = updatedItemsWithIds.map(it => ({
          bill_id: billData.id,
          hsn_code: it.hsn_code || '',
          raw_particulars: it.raw_particulars || '',
          matched_item_name: it.matched_item_name || it.raw_particulars || '',
          master_item_id: it.master_item_id || null,
          qty_or_kg: Number(it.qty_or_kg) || 1,
          unit_rate: Number(it.unit_rate) || 0,
          total_value: Number(it.total_value) || 0
        }));

        const { error: linesErr } = await supabase.from('bill_items').insert(linePayloads);
        if (linesErr) {
          console.error('Warning saving bill_items:', linesErr.message);
        }
      }

      // 4. AUTO-CHECKOFF MATCHING ITEMS IN CURRENT SHOPPING LIST
      const boughtNames = new Set(
        updatedItemsWithIds.map(it => (it.matched_item_name || '').toLowerCase())
      );
      const matchingListIds = shoppingList
        .filter(li => !li.is_checked && boughtNames.has(li.item_name.toLowerCase()))
        .map(li => li.id);

      if (matchingListIds.length > 0) {
        setShoppingList(prev =>
          prev.map(li => (matchingListIds.includes(li.id) ? { ...li, is_checked: true } : li))
        );
        await supabase
          .from('shopping_list')
          .update({ is_checked: true })
          .in('id', matchingListIds);
      }

      // Refresh state & switch to History tab
      setSelectedMonth(month_year);
      await fetchMasterCatalog();
      await fetchBillsHistory(month_year, showAllMonthsHistory);

      showToast(
        `Saved Bill! +${newItemsCreatedCount} new items & +${aliasesLearnedCount} aliases learned!`
      );
      setDraftBill(null);
      setActiveTab('history');
    } catch (err: any) {
      console.error('Save bill error:', err);
      alert(`Could not save bill to Supabase:\n${err.message}`);
      showToast(`Save failed: ${err.message}`);
    } finally {
      setSavingBill(false);
    }
  };

  const handleInspectBill = async (billId: string) => {
    if (activeHistoryBillId === billId) {
      setActiveHistoryBillId(null);
      setSelectedHistoryBillItems(null);
      return;
    }
    setActiveHistoryBillId(billId);
    const { data } = await supabase.from('bill_items').select('*').eq('bill_id', billId);
    setSelectedHistoryBillItems(data || []);
  };

  const handleDeleteBill = async (billId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (!window.confirm('Delete this bill and undo its self-learned items/aliases?')) return;

    try {
      // 1. Fetch line items of the bill being deleted
      const { data: billLines } = await supabase
        .from('bill_items')
        .select('*')
        .eq('bill_id', billId);

      // 2. Fetch remaining line items from OTHER bills so we don't delete shared aliases
      const { data: otherBillLines } = await supabase
        .from('bill_items')
        .select('raw_particulars, matched_item_name')
        .neq('bill_id', billId);

      const stillUsedAliases = new Set(
        (otherBillLines || []).map(l => (l.raw_particulars || '').trim().toUpperCase())
      );

      // 3. Roll back self-learned aliases & auto-created items
      if (billLines && billLines.length > 0) {
        for (const line of billLines) {
          const rawAlias = (line.raw_particulars || '').trim().toUpperCase();
          const master = catalog.find(
            c =>
              c.id === line.master_item_id ||
              c.name.toLowerCase() === (line.matched_item_name || '').toLowerCase()
          );

          if (master && rawAlias && !stillUsedAliases.has(rawAlias)) {
            const updatedAliases = (master.dmart_aliases || []).filter(
              a => a.toUpperCase() !== rawAlias
            );

            // If the only remaining alias is the item's own name AND it was auto-created from this raw text,
            // delete the auto-created item completely; otherwise just remove the learned alias.
            const wasAutoCreatedFromBill =
              updatedAliases.length === 0 ||
              (updatedAliases.length === 1 &&
                updatedAliases[0].toUpperCase() === master.name.toUpperCase() &&
                rawAlias.includes(master.name.toUpperCase()));

            if (wasAutoCreatedFromBill) {
              await supabase.from('master_items').delete().eq('id', master.id);
            } else {
              await supabase
                .from('master_items')
                .update({ dmart_aliases: updatedAliases })
                .eq('id', master.id);
            }
          }
        }
      }

      // 4. Delete the bill and its line items
      await supabase.from('bill_items').delete().eq('bill_id', billId);
      await supabase.from('bills').delete().eq('id', billId);

      setSavedBills(prev => prev.filter(b => b.id !== billId));
      await fetchMasterCatalog();
      showToast('Bill & self-learned items removed!');
    } catch (err: any) {
      showToast(`Delete failed: ${err.message}`);
    }
  };

  const shareListOnWhatsApp = () => {
    if (shoppingList.length === 0) return;
    const lines = [`*Mom's DMart Grocery List (${selectedMonth})*`, ''];
    shoppingList.forEach((it, idx) => {
      const check = it.is_checked ? '✅' : '⬜';
      lines.push(`${idx + 1}. ${check} *${it.item_name}* — ${it.qty} ${it.unit}`);
    });
    const url = `https://wa.me/?text=${encodeURIComponent(lines.join('\n'))}`;
    window.open(url, '_blank');
  };

  return (
    <div className="min-h-screen bg-slate-50 pb-24 font-sans text-slate-900">
      <header className="sticky top-0 z-30 bg-emerald-700 text-white shadow-md px-4 py-3 flex items-center justify-between">
        <div>
          <h1 className="text-lg font-bold tracking-tight flex items-center gap-2">
            🛒 Mom's Grocery & DMart Tracker
          </h1>
          <p className="text-xs text-emerald-100">
            {catalog.length.toLocaleString()} Clean DMart Household Items
          </p>
        </div>

        <input
          type="month"
          value={selectedMonth}
          onChange={e => setSelectedMonth(e.target.value)}
          className="bg-emerald-800 text-white text-xs font-semibold px-2.5 py-1.5 rounded-lg border border-emerald-500 focus:outline-none"
        />
      </header>

      {toast && (
        <div className="fixed bottom-20 left-1/2 -translate-x-1/2 z-50 bg-slate-900 text-white text-xs font-medium px-4 py-2.5 rounded-full shadow-lg">
          {toast}
        </div>
      )}

      {/* ==================== TAB 1: CATALOG ==================== */}
      {activeTab === 'select' && (
        <div className="p-3 max-w-3xl mx-auto space-y-3">
          <div className="flex gap-2">
            <div className="relative flex-1">
              <input
                type="text"
                placeholder={`Search ${catalog.length.toLocaleString()} items...`}
                value={searchQuery}
                onChange={e => setSearchQuery(e.target.value)}
                className="w-full pl-9 pr-8 py-2.5 bg-white border border-slate-300 rounded-xl text-sm shadow-sm focus:ring-2 focus:ring-emerald-600 focus:outline-none"
              />
              <span className="absolute left-3 top-2.5 text-slate-400">🔍</span>
              {searchQuery && (
                <button
                  onClick={() => setSearchQuery('')}
                  className="absolute right-2.5 top-2 text-slate-400 hover:text-slate-600 text-sm font-bold px-1"
                >
                  ✕
                </button>
              )}
            </div>
            <button
              onClick={() => setShowAddCustomModal(true)}
              className="bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-semibold px-3 py-2 rounded-xl shadow-sm whitespace-nowrap"
            >
              + New Item
            </button>
          </div>

          <div className="bg-white p-2.5 rounded-xl border border-slate-200 shadow-sm">
            <div className="flex items-center justify-between mb-1.5">
              <span className="text-[11px] font-bold uppercase tracking-wider text-slate-500">
                1. Category ({categories.length - 1})
              </span>
              {selectedCategory !== 'All' && (
                <button
                  onClick={() => {
                    setSelectedCategory('All');
                    setSelectedSubCategory('All');
                  }}
                  className="text-[11px] text-emerald-600 font-semibold"
                >
                  Reset Filter
                </button>
              )}
            </div>
            <div className="flex gap-1.5 overflow-x-auto pb-1 scrollbar-none">
              {categories.map(cat => (
                <button
                  key={cat}
                  onClick={() => {
                    setSelectedCategory(cat);
                    setSelectedSubCategory('All');
                  }}
                  className={`px-3 py-1.5 rounded-full text-xs font-semibold whitespace-nowrap transition ${
                    selectedCategory === cat
                      ? 'bg-emerald-600 text-white shadow-sm'
                      : 'bg-slate-100 text-slate-700 hover:bg-slate-200'
                  }`}
                >
                  {cat}
                </button>
              ))}
            </div>
          </div>

          <div className="bg-emerald-50/70 p-2.5 rounded-xl border border-emerald-200">
            <div className="flex items-center justify-between mb-1.5">
              <span className="text-[11px] font-bold uppercase tracking-wider text-emerald-800">
                2. Sub-Category {selectedCategory !== 'All' ? `in ${selectedCategory}` : '(All Aisles)'}
              </span>
              {selectedSubCategory !== 'All' && (
                <button
                  onClick={() => setSelectedSubCategory('All')}
                  className="text-[11px] text-emerald-700 font-semibold"
                >
                  Show All Sub-Categories
                </button>
              )}
            </div>
            <div className="flex gap-1.5 overflow-x-auto pb-1 scrollbar-none">
              {subCategories.map(subCat => (
                <button
                  key={subCat}
                  onClick={() => setSelectedSubCategory(subCat)}
                  className={`px-2.5 py-1 rounded-lg text-xs font-medium whitespace-nowrap transition ${
                    selectedSubCategory === subCat
                      ? 'bg-emerald-700 text-white shadow-sm'
                      : 'bg-white text-slate-700 border border-emerald-200 hover:bg-emerald-100'
                  }`}
                >
                  {subCat === 'All' ? 'All Sub-Categories' : formatSubCategoryLabel(subCat)}
                </button>
              ))}
            </div>
          </div>

          <div className="flex items-center justify-between px-1 text-xs text-slate-500 font-medium">
            <span>
              Showing <strong>{Math.min(visibleLimit, filteredCatalog.length)}</strong> of{' '}
              <strong>{filteredCatalog.length.toLocaleString()}</strong> matching items
            </span>
            <span>
              Selected this month: <strong className="text-emerald-700">{shoppingList.length}</strong>
            </span>
          </div>

          {loadingCatalog ? (
            <div className="py-16 text-center text-slate-500 text-sm">
              Loading DMart master catalog from Supabase...
            </div>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
              {filteredCatalog.slice(0, visibleLimit).map(item => {
                const isSelected = selectedMap.has(item.name.toLowerCase());
                return (
                  <div
                    key={item.id || item.name}
                    onClick={() => handleToggleCatalogItem(item)}
                    className={`p-3 rounded-xl border transition cursor-pointer flex items-center justify-between gap-2 ${
                      isSelected
                        ? 'bg-emerald-50 border-emerald-500 shadow-sm'
                        : 'bg-white border-slate-200 hover:border-emerald-400'
                    }`}
                  >
                    <div className="min-w-0 flex-1">
                      <p className="font-semibold text-sm text-slate-900 truncate">{item.name}</p>
                      <div className="flex flex-wrap items-center gap-1 mt-1">
                        <span className="text-[10px] bg-slate-100 text-slate-700 px-2 py-0.5 rounded font-medium">
                          {item.category || 'General'}
                        </span>
                        {item.sub_category && (
                          <span className="text-[10px] bg-emerald-100 text-emerald-800 px-2 py-0.5 rounded font-medium">
                            {formatSubCategoryLabel(item.sub_category)}
                          </span>
                        )}
                        <span className="text-[10px] text-slate-400 ml-1">
                          • {item.default_qty} {item.default_unit}
                        </span>
                      </div>
                    </div>

                    <button
                      type="button"
                      className={`px-3 py-1.5 rounded-lg text-xs font-bold shrink-0 ${
                        isSelected
                          ? 'bg-emerald-600 text-white'
                          : 'bg-slate-100 text-slate-700 hover:bg-emerald-100'
                      }`}
                    >
                      {isSelected ? '✓ Added' : '+ Add'}
                    </button>
                  </div>
                );
              })}
            </div>
          )}

          {filteredCatalog.length > visibleLimit && (
            <button
              onClick={() => setVisibleLimit(prev => prev + 100)}
              className="w-full py-3 bg-white border border-slate-300 rounded-xl text-xs font-bold text-emerald-700 shadow-sm hover:bg-slate-50"
            >
              Show More Items ({filteredCatalog.length - visibleLimit} remaining)
            </button>
          )}
        </div>
      )}

      {/* ==================== TAB 2: SHOPPING LIST ==================== */}
      {activeTab === 'list' && (
        <div className="p-3 max-w-3xl mx-auto space-y-3">
          <div className="bg-white p-3.5 rounded-xl border border-slate-200 space-y-3">
            <div className="flex items-center justify-between">
              <div>
                <h2 className="font-bold text-base">Monthly Grocery List ({selectedMonth})</h2>
                <p className="text-xs text-slate-500">
                  {shoppingList.filter(i => i.is_checked).length} of {shoppingList.length} items bought • Auto-saved
                </p>
              </div>
              {shoppingList.length > 0 && (
                <button
                  onClick={shareListOnWhatsApp}
                  className="bg-green-600 text-white text-xs font-bold px-3.5 py-2 rounded-xl shadow-sm"
                >
                  Share on WhatsApp
                </button>
              )}
            </div>

            <div className="flex flex-wrap gap-2 pt-2 border-t border-slate-100">
              <button
                onClick={handleCopyPreviousMonthList}
                className="bg-emerald-50 text-emerald-700 border border-emerald-200 text-xs font-semibold px-3 py-1.5 rounded-lg hover:bg-emerald-100"
              >
                📋 Copy Last Month's List
              </button>

              {shoppingList.some(i => i.is_checked) && (
                <button
                  onClick={handleClearCheckedItems}
                  className="bg-amber-50 text-amber-700 border border-amber-200 text-xs font-semibold px-3 py-1.5 rounded-lg hover:bg-amber-100"
                >
                  🧹 Remove Checked ({shoppingList.filter(i => i.is_checked).length})
                </button>
              )}

              {shoppingList.length > 0 && (
                <button
                  onClick={handleClearEntireList}
                  className="bg-red-50 text-red-600 border border-red-200 text-xs font-semibold px-3 py-1.5 rounded-lg hover:bg-red-100 ml-auto"
                >
                  🗑️ Clear All
                </button>
              )}
            </div>
          </div>

          {loadingList ? (
            <div className="py-12 text-center text-sm text-slate-400">Loading list...</div>
          ) : shoppingList.length === 0 ? (
            <div className="bg-white p-8 rounded-xl border text-center space-y-2">
              <p className="text-sm text-slate-500">No items added for {selectedMonth} yet.</p>
              <button
                onClick={() => setActiveTab('select')}
                className="bg-emerald-600 text-white text-xs font-bold px-4 py-2 rounded-lg"
              >
                Browse DMart Catalog
              </button>
            </div>
          ) : (
            <div className="space-y-2">
              {shoppingList.map(item => (
                <div
                  key={item.id}
                  className={`p-3 rounded-xl border flex items-center justify-between gap-2 ${
                    item.is_checked
                      ? 'bg-slate-100 border-slate-200 opacity-75'
                      : 'bg-white border-slate-200'
                  }`}
                >
                  <div
                    onClick={() => handleToggleChecked(item)}
                    className="flex items-center gap-2.5 flex-1 cursor-pointer min-w-0"
                  >
                    <input
                      type="checkbox"
                      checked={item.is_checked}
                      onChange={() => {}}
                      className="h-4 w-4 text-emerald-600 rounded"
                    />
                    <div className="min-w-0">
                      <p
                        className={`text-sm font-semibold truncate ${
                          item.is_checked ? 'line-through text-slate-400' : 'text-slate-800'
                        }`}
                      >
                        {item.item_name}
                      </p>
                      <span className="text-[10px] text-slate-500">{item.category}</span>
                    </div>
                  </div>

                  <div className="flex items-center gap-1.5">
                    <input
                      type="number"
                      step="0.25"
                      value={item.qty}
                      onChange={e =>
                        handleUpdateShoppingItem(
                          item.id,
                          parseFloat(e.target.value) || 1,
                          item.unit
                        )
                      }
                      className="w-16 p-1.5 border rounded-lg text-xs text-center font-semibold"
                    />
                    <select
                      value={item.unit}
                      onChange={e => handleUpdateShoppingItem(item.id, item.qty, e.target.value)}
                      className="p-1.5 border rounded-lg text-xs bg-slate-50"
                    >
                      <option value="kg">kg</option>
                      <option value="gm">gm</option>
                      <option value="L">L</option>
                      <option value="ml">ml</option>
                      <option value="pcs">pcs</option>
                      <option value="packet">pkt</option>
                    </select>
                    <button
                      onClick={() => handleDeleteShoppingItem(item.id)}
                      className="text-red-500 hover:bg-red-50 p-1.5 rounded-lg text-xs font-bold"
                    >
                      ✕
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ==================== TAB 3: SCAN BILL (SELF-LEARNING) ==================== */}
      {activeTab === 'scan' && (
        <div className="p-3 max-w-3xl mx-auto space-y-4">
          <div className="bg-white p-5 rounded-xl border border-slate-200 text-center space-y-3">
            <h2 className="font-bold text-base">Scan DMart Bill (AI + Auto Self-Learning)</h2>
            <p className="text-xs text-slate-500">
              Upload a DMart receipt photo. Known items learn new store aliases, and brand-new products automatically create their own Category & Sub-Category in your Catalog!
            </p>

            <label className="inline-block bg-emerald-600 hover:bg-emerald-700 text-white text-sm font-bold px-5 py-3 rounded-xl shadow cursor-pointer">
              📸 Take Photo / Upload Receipt
              <input
                type="file"
                accept="image/*"
                onChange={handleReceiptUpload}
                className="hidden"
              />
            </label>

            {scanning && (
              <div className="space-y-1.5 pt-2">
                <div className="w-full bg-slate-200 h-2.5 rounded-full overflow-hidden">
                  <div
                    className="bg-emerald-600 h-full transition-all"
                    style={{ width: `${scanProgress}%` }}
                  />
                </div>
                <p className="text-xs text-emerald-700 font-semibold">
                  Scanning Receipt... {scanProgress}%
                </p>
              </div>
            )}

            {scanError && (
              <div className="p-3 bg-red-50 text-red-700 rounded-lg text-xs font-medium">
                {scanError}
              </div>
            )}
          </div>

          {draftBill && (
            <div className="bg-white p-4 rounded-xl border border-emerald-300 space-y-3 shadow-sm">
              <div className="flex items-center justify-between border-b pb-2">
                <div>
                  <h3 className="font-bold text-sm text-emerald-900">
                    Verified Bill: {draftBill.store_name} ({draftBill.bill_date})
                  </h3>
                  <p className="text-xs text-slate-500">
                    {draftBill.items.length} items • Total: ₹{Number(draftBill.total_amount || 0).toFixed(2)} • Month: {draftBill.month_year}
                  </p>
                </div>
                <button
                  onClick={saveVerifiedBillToDb}
                  disabled={savingBill}
                  className="bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-bold px-4 py-2 rounded-lg shadow"
                >
                  {savingBill ? 'Saving to DB...' : 'Save Verified Bill ✓'}
                </button>
              </div>

              <div className="space-y-2 max-h-96 overflow-y-auto">
                {draftBill.items.map((it, idx) => {
                  const existsInCatalog = catalog.some(
                    c => c.name.toLowerCase() === (it.matched_item_name || '').toLowerCase()
                  );
                  const autoCat = inferCategoryAndSubCategory(
                    it.hsn_code,
                    it.raw_particulars,
                    it.matched_item_name
                  );

                  return (
                    <div key={idx} className="p-2.5 bg-slate-50 rounded-lg border text-xs space-y-1.5">
                      <div className="flex justify-between font-bold text-slate-800">
                        <span>Raw Receipt: {it.raw_particulars}</span>
                        <span>
                          {it.qty_or_kg} × ₹{it.unit_rate} = ₹{it.total_value}
                        </span>
                      </div>

                      <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
                        <div className="flex items-center gap-1.5 flex-1 min-w-[200px]">
                          <span className="text-slate-500 shrink-0">Catalog Name:</span>
                          <input
                            type="text"
                            value={it.matched_item_name}
                            onChange={e => handleDraftItemNameChange(idx, e.target.value)}
                            className="px-2 py-1 border rounded bg-white font-semibold text-emerald-800 text-xs flex-1"
                          />
                        </div>

                        {existsInCatalog ? (
                          <span className="text-[10px] bg-emerald-100 text-emerald-800 px-2 py-0.5 rounded font-semibold">
                            ✓ In Catalog (Learns Alias)
                          </span>
                        ) : (
                          <span className="text-[10px] bg-amber-100 text-amber-800 px-2 py-0.5 rounded font-semibold">
                            ✨ New Item → {autoCat.category} / {autoCat.sub_category}
                          </span>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      )}

      {/* ==================== TAB 4: HISTORY ==================== */}
      {activeTab === 'history' && (
        <div className="p-3 max-w-3xl mx-auto space-y-3">
          <div className="bg-white p-4 rounded-xl border border-slate-200 flex flex-wrap justify-between items-center gap-2">
            <div>
              <h2 className="font-bold text-base">
                Saved Bills History ({showAllMonthsHistory ? 'All Months' : selectedMonth})
              </h2>
              <div className="flex items-center gap-2 mt-1">
                <span className="text-xs text-slate-500">{savedBills.length} bills recorded</span>
                <button
                  onClick={() => setShowAllMonthsHistory(prev => !prev)}
                  className="text-[11px] bg-emerald-50 text-emerald-700 border border-emerald-200 px-2 py-0.5 rounded font-semibold"
                >
                  {showAllMonthsHistory ? `Filter by ${selectedMonth} Only` : 'Show All Months'}
                </button>
              </div>
            </div>
            <div className="text-right">
              <p className="text-xs text-slate-500">Total Spend</p>
              <p className="text-lg font-extrabold text-emerald-700">
                ₹{savedBills.reduce((s, b) => s + (Number(b.total_amount) || 0), 0).toFixed(2)}
              </p>
            </div>
          </div>

          {savedBills.length === 0 ? (
            <div className="bg-white p-8 rounded-xl border text-center text-sm text-slate-400">
              No saved bills found. Scan a DMart receipt in Tab 3 and tap "Save Verified Bill ✓"!
            </div>
          ) : (
            savedBills.map(bill => (
              <div key={bill.id} className="bg-white p-3.5 rounded-xl border border-slate-200 space-y-2">
                <div
                  onClick={() => handleInspectBill(bill.id)}
                  className="flex justify-between items-center cursor-pointer"
                >
                  <div>
                    <p className="font-bold text-sm text-slate-800">
                      {bill.store_name} — {bill.bill_date}
                    </p>
                    <p className="text-xs text-slate-500">
                      {bill.total_items_count} items • Month: {bill.month_year} • Saved ₹
                      {bill.total_savings || 0}
                    </p>
                  </div>
                  <div className="text-right flex items-center gap-3">
                    <div>
                      <p className="font-bold text-sm text-emerald-700">
                        ₹{Number(bill.total_amount || 0).toFixed(2)}
                      </p>
                      <span className="text-[10px] text-blue-600 font-semibold">
                        {activeHistoryBillId === bill.id ? 'Hide Items ▲' : 'View Items ▼'}
                      </span>
                    </div>
                    <button
                      onClick={e => handleDeleteBill(bill.id, e)}
                      className="text-red-400 hover:text-red-600 text-xs font-bold p-1"
                      title="Delete Bill"
                    >
                      🗑️
                    </button>
                  </div>
                </div>

                {activeHistoryBillId === bill.id && selectedHistoryBillItems && (
                  <div className="border-t pt-2 space-y-1 text-xs">
                    {selectedHistoryBillItems.map((bi, i) => (
                      <div key={i} className="flex justify-between py-1 border-b border-slate-100">
                        <span className="font-medium text-slate-700">
                          {bi.matched_item_name || bi.raw_particulars}
                          <span className="text-[10px] text-slate-400 ml-1">
                            ({bi.raw_particulars})
                          </span>
                        </span>
                        <span className="text-slate-500">
                          {bi.qty_or_kg} × ₹{bi.unit_rate} = <strong>₹{bi.total_value}</strong>
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ))
          )}
        </div>
      )}

      {showAddCustomModal && (
        <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4">
          <form
            onSubmit={handleAddCustomMasterItem}
            className="bg-white rounded-2xl p-5 w-full max-w-md space-y-3 shadow-xl"
          >
            <h3 className="font-bold text-base">Add Custom Item to Master Catalog</h3>
            <input
              type="text"
              required
              placeholder="Item Name (e.g., Kolhapuri Jaggery)"
              value={customItemName}
              onChange={e => setCustomItemName(e.target.value)}
              className="w-full p-2.5 border rounded-xl text-sm"
            />
            <div className="grid grid-cols-2 gap-2">
              <input
                type="text"
                placeholder="Category (e.g., Grocery)"
                value={customItemCat}
                onChange={e => setCustomItemCat(e.target.value)}
                className="p-2.5 border rounded-xl text-sm"
              />
              <input
                type="text"
                placeholder="Sub-Category (e.g., Dry Fruits)"
                value={customItemSubCat}
                onChange={e => setCustomItemSubCat(e.target.value)}
                className="p-2.5 border rounded-xl text-sm"
              />
            </div>
            <div className="grid grid-cols-2 gap-2">
              <input
                type="number"
                step="0.25"
                value={customItemQty}
                onChange={e => setCustomItemQty(parseFloat(e.target.value) || 1)}
                className="p-2.5 border rounded-xl text-sm"
              />
              <select
                value={customItemUnit}
                onChange={e => setCustomItemUnit(e.target.value)}
                className="p-2.5 border rounded-xl text-sm"
              >
                <option value="kg">kg</option>
                <option value="gm">gm</option>
                <option value="L">L</option>
                <option value="ml">ml</option>
                <option value="pcs">pcs</option>
              </select>
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={() => setShowAddCustomModal(false)}
                className="px-4 py-2 text-xs font-semibold text-slate-600"
              >
                Cancel
              </button>
              <button
                type="submit"
                className="px-4 py-2 bg-emerald-600 text-white text-xs font-bold rounded-xl"
              >
                Save & Add
              </button>
            </div>
          </form>
        </div>
      )}

      <nav className="fixed bottom-0 left-0 right-0 z-40 bg-white border-t border-slate-200 flex justify-around py-2 shadow-lg">
        <button
          onClick={() => setActiveTab('select')}
          className={`flex flex-col items-center text-xs font-bold ${
            activeTab === 'select' ? 'text-emerald-600' : 'text-slate-400'
          }`}
        >
          <span className="text-lg">🏬</span>
          <span>1. Catalog ({catalog.length})</span>
        </button>
        <button
          onClick={() => setActiveTab('list')}
          className={`flex flex-col items-center text-xs font-bold ${
            activeTab === 'list' ? 'text-emerald-600' : 'text-slate-400'
          }`}
        >
          <span className="text-lg">📝</span>
          <span>2. List ({shoppingList.length})</span>
        </button>
        <button
          onClick={() => setActiveTab('scan')}
          className={`flex flex-col items-center text-xs font-bold ${
            activeTab === 'scan' ? 'text-emerald-600' : 'text-slate-400'
          }`}
        >
          <span className="text-lg">📸</span>
          <span>3. Scan Bill</span>
        </button>
        <button
          onClick={() => setActiveTab('history')}
          className={`flex flex-col items-center text-xs font-bold ${
            activeTab === 'history' ? 'text-emerald-600' : 'text-slate-400'
          }`}
        >
          <span className="text-lg">📊</span>
          <span>4. History ({savedBills.length})</span>
        </button>
      </nav>
    </div>
  );
}