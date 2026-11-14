import React, { useEffect, useState, useMemo } from 'react';
import { supabase } from './supabaseClient';
import {
  type MasterItem,
  type ParsedBill,
  type ParsedBillItem,
  extractDMartBillFromImage
} from './dmartParser';
import {
  CheckSquare,
  ShoppingCart,
  ScanLine,
  BarChart3,
  Search,
  Plus,
  Minus,
  Trash2,
  Share2,
  Copy,
  Check,
  TrendingUp,
  TrendingDown,
  AlertCircle,
  Sparkles,
  Upload
} from 'lucide-react';

interface MonthlyListItem {
  id?: string;
  list_id?: string;
  master_item_id: string | null;
  item_name: string;
  category: string;
  quantity: number;
  unit: string;
  is_purchased: boolean;
}

interface SavedBill extends ParsedBill {
  id: string;
}

const UNITS = ['kg', 'gm', 'L', 'ml', 'packet', 'pcs'];

export default function App() {
  const [activeTab, setActiveTab] = useState<'select' | 'final' | 'scan' | 'analysis'>('select');
  const [selectedMonth, setSelectedMonth] = useState<string>(() => new Date().toISOString().slice(0, 7));
  const [catalog, setCatalog] = useState<MasterItem[]>([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedCategory, setSelectedCategory] = useState('All');

  const [currentListId, setCurrentListId] = useState<string | null>(null);
  const [monthlyItems, setMonthlyItems] = useState<MonthlyListItem[]>([]);

  const [showAddModal, setShowAddModal] = useState(false);
  const [newItemName, setNewItemName] = useState('');
  const [newItemCategory, setNewItemCategory] = useState('Dals & Pulses');
  const [newItemUnit, setNewItemUnit] = useState('kg');

  const [ocrProgress, setOcrProgress] = useState<number | null>(null);
  const [draftBill, setDraftBill] = useState<ParsedBill | null>(null);
  const [savedBills, setSavedBills] = useState<SavedBill[]>([]);
  const [toastMsg, setToastMsg] = useState<string | null>(null);

  const showToast = (msg: string) => {
    setToastMsg(msg);
    setTimeout(() => setToastMsg(null), 3500);
  };

  useEffect(() => {
    fetchCatalog();
    fetchAllBills();
  }, []);

  useEffect(() => {
    fetchMonthlyList(selectedMonth);
  }, [selectedMonth]);

  async function fetchCatalog() {
    const { data } = await supabase.from('master_items').select('*').order('category').order('name');
    if (data) setCatalog(data);
  }

  async function fetchMonthlyList(monthYear: string) {
    const { data: listRow } = await supabase
      .from('monthly_lists')
      .upsert({ month_year: monthYear, status: 'active' }, { onConflict: 'month_year' })
      .select()
      .single();

    if (listRow) {
      setCurrentListId(listRow.id);
      const { data: items } = await supabase
        .from('monthly_list_items')
        .select('*')
        .eq('list_id', listRow.id)
        .order('category');
      setMonthlyItems(items || []);
    }
  }

  async function fetchAllBills() {
    const { data: billsData } = await supabase
      .from('bills')
      .select('*')
      .order('bill_date', { ascending: false });

    if (!billsData) return;

    const fullBills: SavedBill[] = [];
    for (const b of billsData) {
      const { data: bItems } = await supabase.from('bill_items').select('*').eq('bill_id', b.id);
      fullBills.push({
        ...b,
        items: bItems || []
      });
    }
    setSavedBills(fullBills);
  }

  const categories = useMemo(() => {
    const set = new Set<string>(['All']);
    catalog.forEach(i => set.add(i.category));
    return Array.from(set);
  }, [catalog]);

  const filteredCatalog = useMemo(() => {
    return catalog.filter(item => {
      const matchesCat = selectedCategory === 'All' || item.category === selectedCategory;
      const matchesSearch = item.name.toLowerCase().includes(searchQuery.toLowerCase());
      return matchesCat && matchesSearch;
    });
  }, [catalog, selectedCategory, searchQuery]);

  async function toggleMasterItem(item: MasterItem) {
    if (!currentListId) return;
    const existing = monthlyItems.find(m => m.item_name === item.name);

    if (existing && existing.id) {
      await supabase.from('monthly_list_items').delete().eq('id', existing.id);
      setMonthlyItems(prev => prev.filter(m => m.id !== existing.id));
    } else {
      const newEntry: MonthlyListItem = {
        list_id: currentListId,
        master_item_id: item.id,
        item_name: item.name,
        category: item.category,
        quantity: Number(item.default_qty) || 1,
        unit: item.default_unit || 'kg',
        is_purchased: false
      };
      const { data } = await supabase.from('monthly_list_items').insert(newEntry).select().single();
      if (data) setMonthlyItems(prev => [...prev, data]);
    }
  }

  async function updateItemQtyOrUnit(item: MonthlyListItem, newQty: number, newUnit: string) {
    if (!item.id || newQty <= 0) return;
    const roundedQty = Math.round(newQty * 100) / 100;
    await supabase
      .from('monthly_list_items')
      .update({ quantity: roundedQty, unit: newUnit })
      .eq('id', item.id);

    setMonthlyItems(prev =>
      prev.map(m => (m.id === item.id ? { ...m, quantity: roundedQty, unit: newUnit } : m))
    );
  }

  async function togglePurchasedCheck(item: MonthlyListItem) {
    if (!item.id) return;
    const nextVal = !item.is_purchased;
    await supabase.from('monthly_list_items').update({ is_purchased: nextVal }).eq('id', item.id);
    setMonthlyItems(prev => prev.map(m => (m.id === item.id ? { ...m, is_purchased: nextVal } : m)));
  }

  async function removeMonthlyItem(id?: string) {
    if (!id) return;
    await supabase.from('monthly_list_items').delete().eq('id', id);
    setMonthlyItems(prev => prev.filter(m => m.id !== id));
  }

  async function handleAddCustomMasterItem() {
    if (!newItemName.trim()) return;
    const { data, error } = await supabase
      .from('master_items')
      .insert({
        name: newItemName.trim(),
        category: newItemCategory,
        default_unit: newItemUnit,
        default_qty: 1,
        dmart_aliases: [newItemName.trim().toUpperCase()]
      })
      .select()
      .single();

    if (!error && data) {
      setCatalog(prev => [...prev, data]);
      await toggleMasterItem(data);
      setNewItemName('');
      setShowAddModal(false);
      showToast(`Added "${data.name}" to Catalog!`);
    }
  }

  function generateWhatsAppText(): string {
    const grouped: Record<string, MonthlyListItem[]> = {};
    monthlyItems.forEach(item => {
      if (!grouped[item.category]) grouped[item.category] = [];
      grouped[item.category].push(item);
    });

    let text = `🛒 *Household Grocery List (${selectedMonth})*\n\n`;
    Object.entries(grouped).forEach(([cat, items]) => {
      text += `*${cat}*\n`;
      items.forEach(i => {
        text += `• ${i.item_name} - ${i.quantity} ${i.unit}${i.is_purchased ? ' ✅' : ''}\n`;
      });
      text += '\n';
    });
    return text.trim();
  }

  function handleShareWhatsApp() {
    const text = generateWhatsAppText();
    const url = `https://wa.me/?text=${encodeURIComponent(text)}`;
    window.open(url, '_blank');
  }

  function handleCopyList() {
    navigator.clipboard.writeText(generateWhatsAppText());
    showToast('Grocery list copied to clipboard!');
  }

  async function handleBillPhotoUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setOcrProgress(5);
    try {
      const parsed = await extractDMartBillFromImage(file, catalog, pct => setOcrProgress(pct));
      setDraftBill(parsed);
      if (parsed.items.length > 0) {
        showToast(`Extracted ${parsed.items.length} items from receipt!`);
      } else {
        showToast('No tabular items detected. Please try a clearer image or add rows manually.');
      }
    } catch (err: any) {
      console.error('Receipt extraction failed:', err);
      showToast(err?.message || 'Failed to extract bill from photo.');
    } finally {
      setOcrProgress(null);
      e.target.value = '';
    }
  }

  async function saveVerifiedBillToDb() {
    if (!draftBill || draftBill.items.length === 0) return;

    const totalVal = Number(draftBill.items.reduce((s, i) => s + Number(i.total_value), 0).toFixed(2));
    const totalQty = Number(draftBill.items.reduce((s, i) => s + Number(i.qty_or_kg), 0).toFixed(3));

    const { data: billRow, error } = await supabase
      .from('bills')
      .insert({
        store_name: draftBill.store_name,
        bill_date: draftBill.bill_date,
        month_year: draftBill.bill_date.slice(0, 7),
        bill_number: draftBill.bill_number,
        total_items_count: draftBill.items.length,
        total_qty_count: totalQty,
        total_amount: totalVal,
        total_savings: draftBill.total_savings
      })
      .select()
      .single();

    if (error || !billRow) {
      showToast('Error saving bill to database');
      return;
    }

    const itemsPayload = draftBill.items.map(it => ({
      bill_id: billRow.id,
      hsn_code: it.hsn_code,
      raw_particulars: it.raw_particulars,
      master_item_id: it.master_item_id,
      matched_item_name: it.matched_item_name,
      qty_or_kg: Number(it.qty_or_kg),
      unit_rate: Number(it.unit_rate),
      total_value: Number(it.total_value)
    }));

    await supabase.from('bill_items').insert(itemsPayload);

    for (const it of draftBill.items) {
      const master = catalog.find(c => c.name === it.matched_item_name);
      if (master && it.raw_particulars && !master.dmart_aliases?.includes(it.raw_particulars)) {
        const updatedAliases = [...(master.dmart_aliases || []), it.raw_particulars];
        await supabase.from('master_items').update({ dmart_aliases: updatedAliases }).eq('id', master.id);
      }
    }

    const billMonth = draftBill.bill_date.slice(0, 7);
    setSelectedMonth(billMonth);
    setDraftBill(null);
    await fetchAllBills();
    showToast('Bill saved to database!');
    setActiveTab('analysis');
  }

  async function deleteSavedBill(billId: string) {
    await supabase.from('bills').delete().eq('id', billId);
    await fetchAllBills();
    showToast('Bill deleted');
  }

  const analysis = useMemo(() => {
    const currentMonthBills = savedBills.filter(b => b.month_year === selectedMonth);
    const currentBill = currentMonthBills[0] || null;
    const previousBill = savedBills.find(b => b.month_year < selectedMonth) || null;

    const priceShotUp: Array<{ name: string; oldRate: number; newRate: number; diff: number; pct: number }> = [];
    const priceDeclined: Array<{ name: string; oldRate: number; newRate: number; diff: number; pct: number }> = [];
    const purchasedExtra: ParsedBillItem[] = [];
    const notPurchased: MonthlyListItem[] = [];

    if (currentBill) {
      if (previousBill) {
        currentBill.items.forEach(currItem => {
          const prevItem = previousBill.items.find(
            p => p.matched_item_name.toLowerCase() === currItem.matched_item_name.toLowerCase()
          );
          if (prevItem && prevItem.unit_rate > 0) {
            const diff = Number((currItem.unit_rate - prevItem.unit_rate).toFixed(2));
            const pct = Number(((diff / prevItem.unit_rate) * 100).toFixed(1));
            if (diff > 0.05) {
              priceShotUp.push({
                name: currItem.matched_item_name,
                oldRate: prevItem.unit_rate,
                newRate: currItem.unit_rate,
                diff,
                pct
              });
            } else if (diff < -0.05) {
              priceDeclined.push({
                name: currItem.matched_item_name,
                oldRate: prevItem.unit_rate,
                newRate: currItem.unit_rate,
                diff: Math.abs(diff),
                pct: Math.abs(pct)
              });
            }
          }
        });
      }

      const plannedNames = new Set(monthlyItems.map(m => m.item_name.toLowerCase()));
      const billedNames = new Set(currentBill.items.map(b => b.matched_item_name.toLowerCase()));

      currentBill.items.forEach(bItem => {
        if (!plannedNames.has(bItem.matched_item_name.toLowerCase())) {
          purchasedExtra.push(bItem);
        }
      });

      monthlyItems.forEach(mItem => {
        if (!billedNames.has(mItem.item_name.toLowerCase())) {
          notPurchased.push(mItem);
        }
      });
    }

    return {
      currentBill,
      previousBill,
      priceShotUp,
      priceDeclined,
      purchasedExtra,
      notPurchased
    };
  }, [savedBills, selectedMonth, monthlyItems]);

  return (
    <div className="max-w-md mx-auto min-h-screen bg-slate-50 pb-28 shadow-xl border-x border-slate-200 flex flex-col">
      <header className="bg-emerald-700 text-white px-4 py-3.5 sticky top-0 z-30 shadow-md flex items-center justify-between">
        <div>
          <h1 className="text-lg font-bold tracking-tight">Mom's Grocery & Bills</h1>
          <p className="text-xs text-emerald-100">Household List & Price Tracker</p>
        </div>
        <input
          type="month"
          value={selectedMonth}
          onChange={e => setSelectedMonth(e.target.value)}
          className="bg-emerald-800 text-white text-sm font-semibold px-2.5 py-1.5 rounded-lg border border-emerald-500 focus:outline-none"
        />
      </header>

      {toastMsg && (
        <div className="fixed top-16 left-1/2 -translate-x-1/2 z-50 bg-slate-900 text-white text-sm font-medium px-4 py-2.5 rounded-xl shadow-lg flex items-center gap-2 max-w-xs text-center">
          <Sparkles className="w-4 h-4 text-emerald-400 shrink-0" />
          <span>{toastMsg}</span>
        </div>
      )}

      {activeTab === 'select' && (
        <div className="p-3 space-y-3 flex-1">
          <div className="flex gap-2">
            <div className="relative flex-1">
              <Search className="w-5 h-5 text-slate-400 absolute left-3 top-3" />
              <input
                type="text"
                placeholder="Search items..."
                value={searchQuery}
                onChange={e => setSearchQuery(e.target.value)}
                className="w-full pl-10 pr-3 py-2.5 bg-white border border-slate-300 rounded-xl text-base focus:outline-none focus:border-emerald-600"
              />
            </div>
            <button
              onClick={() => setShowAddModal(true)}
              className="bg-emerald-600 text-white px-3.5 rounded-xl font-semibold text-sm flex items-center gap-1 shrink-0 active:scale-95"
            >
              <Plus className="w-5 h-5" /> New
            </button>
          </div>

          <div className="flex gap-2 overflow-x-auto pb-1.5 no-scrollbar">
            {categories.map(cat => (
              <button
                key={cat}
                onClick={() => setSelectedCategory(cat)}
                className={`px-3.5 py-2 rounded-full text-sm font-semibold whitespace-nowrap transition ${
                  selectedCategory === cat
                    ? 'bg-emerald-700 text-white shadow-sm'
                    : 'bg-white text-slate-700 border border-slate-200'
                }`}
              >
                {cat}
              </button>
            ))}
          </div>

          <div className="space-y-2">
            {filteredCatalog.map(item => {
              const selectedEntry = monthlyItems.find(m => m.item_name === item.name);
              const isSelected = Boolean(selectedEntry);

              return (
                <div
                  key={item.id}
                  className={`p-3.5 rounded-xl border transition ${
                    isSelected
                      ? 'bg-emerald-50/80 border-emerald-600 shadow-xs'
                      : 'bg-white border-slate-200'
                  }`}
                >
                  <div
                    onClick={() => toggleMasterItem(item)}
                    className="flex items-center justify-between cursor-pointer"
                  >
                    <div>
                      <p className="text-base font-bold text-slate-900">{item.name}</p>
                      <p className="text-xs text-slate-500">{item.category}</p>
                    </div>
                    <div
                      className={`w-7 h-7 rounded-lg flex items-center justify-center border-2 ${
                        isSelected
                          ? 'bg-emerald-600 border-emerald-600 text-white'
                          : 'border-slate-300 bg-slate-50'
                      }`}
                    >
                      {isSelected && <Check className="w-5 h-5 stroke-[3]" />}
                    </div>
                  </div>

                  {isSelected && selectedEntry && (
                    <div className="mt-3 pt-2.5 border-t border-emerald-200 flex items-center justify-between gap-2">
                      <span className="text-xs font-semibold text-emerald-900">Qty & Unit:</span>
                      <div className="flex items-center gap-1.5">
                        <button
                          onClick={() =>
                            updateItemQtyOrUnit(
                              selectedEntry,
                              Math.max(0.5, Number(selectedEntry.quantity) - 0.5),
                              selectedEntry.unit
                            )
                          }
                          className="w-9 h-9 rounded-lg bg-white border border-emerald-300 flex items-center justify-center text-emerald-800 font-bold active:bg-emerald-100"
                        >
                          <Minus className="w-4 h-4" />
                        </button>
                        <input
                          type="number"
                          step="0.5"
                          value={selectedEntry.quantity}
                          onChange={e =>
                            updateItemQtyOrUnit(
                              selectedEntry,
                              parseFloat(e.target.value) || 1,
                              selectedEntry.unit
                            )
                          }
                          className="w-16 h-9 text-center font-bold bg-white border border-emerald-300 rounded-lg text-base"
                        />
                        <button
                          onClick={() =>
                            updateItemQtyOrUnit(
                              selectedEntry,
                              Number(selectedEntry.quantity) + 0.5,
                              selectedEntry.unit
                            )
                          }
                          className="w-9 h-9 rounded-lg bg-white border border-emerald-300 flex items-center justify-center text-emerald-800 font-bold active:bg-emerald-100"
                        >
                          <Plus className="w-4 h-4" />
                        </button>
                        <select
                          value={selectedEntry.unit}
                          onChange={e =>
                            updateItemQtyOrUnit(selectedEntry, selectedEntry.quantity, e.target.value)
                          }
                          className="h-9 px-2 bg-white border border-emerald-300 rounded-lg font-semibold text-sm text-slate-800"
                        >
                          {UNITS.map(u => (
                            <option key={u} value={u}>
                              {u}
                            </option>
                          ))}
                        </select>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          {monthlyItems.length > 0 && (
            <div className="sticky bottom-20 bg-slate-900 text-white p-3.5 rounded-2xl shadow-lg flex items-center justify-between">
              <div>
                <p className="text-sm font-bold">{monthlyItems.length} Items Selected</p>
                <p className="text-xs text-slate-300">For {selectedMonth}</p>
              </div>
              <button
                onClick={() => setActiveTab('final')}
                className="bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-bold px-4 py-2.5 rounded-xl text-sm"
              >
                View Final List →
              </button>
            </div>
          )}
        </div>
      )}

      {activeTab === 'final' && (
        <div className="p-3 space-y-4 flex-1">
          <div className="bg-white p-4 rounded-2xl border border-slate-200 shadow-xs flex items-center justify-between">
            <div>
              <h2 className="text-base font-bold text-slate-900">Final List ({selectedMonth})</h2>
              <p className="text-xs text-slate-500">
                {monthlyItems.filter(i => i.is_purchased).length} of {monthlyItems.length} items picked
              </p>
            </div>
            <div className="flex gap-2">
              <button
                onClick={handleCopyList}
                className="p-2.5 bg-slate-100 text-slate-700 rounded-xl font-semibold text-sm flex items-center gap-1"
              >
                <Copy className="w-4 h-4" /> Copy
              </button>
              <button
                onClick={handleShareWhatsApp}
                className="px-3.5 py-2.5 bg-emerald-600 text-white rounded-xl font-bold text-sm flex items-center gap-1.5 shadow-xs"
              >
                <Share2 className="w-4 h-4" /> WhatsApp
              </button>
            </div>
          </div>

          {monthlyItems.length === 0 ? (
            <div className="text-center py-12 bg-white rounded-2xl border border-slate-200 p-6">
              <ShoppingCart className="w-12 h-12 text-slate-300 mx-auto mb-2" />
              <p className="font-bold text-slate-700">No items selected for {selectedMonth}</p>
              <p className="text-sm text-slate-500 mt-1">
                Go to "Select" and tap the items needed this month.
              </p>
              <button
                onClick={() => setActiveTab('select')}
                className="mt-4 bg-emerald-600 text-white font-bold px-5 py-2.5 rounded-xl text-sm"
              >
                Select Items Now
              </button>
            </div>
          ) : (
            <div className="space-y-2.5">
              {monthlyItems.map(item => (
                <div
                  key={item.id}
                  className={`p-3.5 rounded-xl border bg-white flex flex-col gap-2.5 ${
                    item.is_purchased ? 'opacity-60 border-slate-200' : 'border-slate-300'
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <div
                      onClick={() => togglePurchasedCheck(item)}
                      className="flex items-center gap-3 cursor-pointer flex-1"
                    >
                      <div
                        className={`w-6 h-6 rounded-md flex items-center justify-center border-2 ${
                          item.is_purchased
                            ? 'bg-emerald-600 border-emerald-600 text-white'
                            : 'border-slate-400'
                        }`}
                      >
                        {item.is_purchased && <Check className="w-4 h-4 stroke-[3]" />}
                      </div>
                      <div>
                        <p
                          className={`text-base font-bold ${
                            item.is_purchased ? 'line-through text-slate-400' : 'text-slate-900'
                          }`}
                        >
                          {item.item_name}
                        </p>
                        <p className="text-xs text-slate-500">{item.category}</p>
                      </div>
                    </div>

                    <button
                      onClick={() => removeMonthlyItem(item.id)}
                      className="p-2 text-red-500 hover:bg-red-50 rounded-lg"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>

                  <div className="flex items-center justify-end gap-2 pt-2 border-t border-slate-100">
                    <button
                      onClick={() =>
                        updateItemQtyOrUnit(item, Math.max(0.5, Number(item.quantity) - 0.5), item.unit)
                      }
                      className="w-8 h-8 rounded-lg bg-slate-100 flex items-center justify-center font-bold"
                    >
                      -
                    </button>
                    <input
                      type="number"
                      step="0.5"
                      value={item.quantity}
                      onChange={e =>
                        updateItemQtyOrUnit(item, parseFloat(e.target.value) || 1, item.unit)
                      }
                      className="w-16 h-8 text-center font-bold border border-slate-300 rounded-lg text-sm"
                    />
                    <button
                      onClick={() =>
                        updateItemQtyOrUnit(item, Number(item.quantity) + 0.5, item.unit)
                      }
                      className="w-8 h-8 rounded-lg bg-slate-100 flex items-center justify-center font-bold"
                    >
                      +
                    </button>
                    <select
                      value={item.unit}
                      onChange={e => updateItemQtyOrUnit(item, item.quantity, e.target.value)}
                      className="h-8 px-2 bg-slate-100 border border-slate-300 rounded-lg text-sm font-semibold"
                    >
                      {UNITS.map(u => (
                        <option key={u} value={u}>
                          {u}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {activeTab === 'scan' && (
        <div className="p-3 space-y-4 flex-1">
          <div className="bg-white p-4 rounded-2xl border border-slate-200 space-y-3">
            <h2 className="text-base font-bold text-slate-900">Upload Shopping Bill</h2>
            <p className="text-xs text-slate-600">
              Upload a photo of your physical shopping bill to extract items, quantities, and unit rates automatically.
            </p>

            <label className="w-full py-4 bg-emerald-600 hover:bg-emerald-700 text-white font-bold rounded-xl flex items-center justify-center gap-2 cursor-pointer shadow-sm">
              <Upload className="w-5 h-5" />
              <span>Take Photo / Upload Bill Image</span>
              <input
                type="file"
                accept="image/*"
                onChange={handleBillPhotoUpload}
                className="hidden"
              />
            </label>

            {ocrProgress !== null && (
              <div className="p-3 bg-emerald-50 border border-emerald-200 rounded-xl">
                <p className="text-xs font-bold text-emerald-900 mb-1">
                  Reading Receipt... {ocrProgress}%
                </p>
                <div className="w-full bg-emerald-200 h-2.5 rounded-full overflow-hidden">
                  <div
                    className="bg-emerald-600 h-full transition-all"
                    style={{ width: `${ocrProgress}%` }}
                  />
                </div>
              </div>
            )}
          </div>

          {draftBill && (
            <div className="bg-white p-4 rounded-2xl border-2 border-emerald-600 space-y-3">
              <div className="flex items-center justify-between border-b pb-2">
                <div>
                  <h3 className="font-bold text-slate-900 text-base">Verify Extracted Bill</h3>
                  <p className="text-xs text-slate-500">
                    {draftBill.items.length} items • Saved ₹{draftBill.total_savings} on MRP
                  </p>
                </div>
                <input
                  type="date"
                  value={draftBill.bill_date}
                  onChange={e =>
                    setDraftBill({
                      ...draftBill,
                      bill_date: e.target.value,
                      month_year: e.target.value.slice(0, 7)
                    })
                  }
                  className="border border-slate-300 rounded-lg px-2 py-1 text-xs font-bold"
                />
              </div>

              <div className="space-y-2.5 max-h-96 overflow-y-auto pr-1">
                {draftBill.items.map((item, idx) => (
                  <div key={idx} className="p-2.5 bg-slate-50 rounded-xl border border-slate-200 space-y-2">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-xs font-mono text-slate-500 truncate">
                        Raw: {item.raw_particulars}
                      </span>
                      <button
                        onClick={() => {
                          const updated = draftBill.items.filter((_, i) => i !== idx);
                          setDraftBill({ ...draftBill, items: updated });
                        }}
                        className="text-red-500 text-xs font-bold"
                      >
                        Remove
                      </button>
                    </div>

                    <div className="flex items-center gap-2">
                      <select
                        value={item.matched_item_name}
                        onChange={e => {
                          const updated = [...draftBill.items];
                          const found = catalog.find(c => c.name === e.target.value);
                          updated[idx] = {
                            ...item,
                            matched_item_name: e.target.value,
                            master_item_id: found ? found.id : null
                          };
                          setDraftBill({ ...draftBill, items: updated });
                        }}
                        className="flex-1 bg-white border border-slate-300 rounded-lg px-2 py-1.5 text-sm font-bold text-slate-900"
                      >
                        <option value={item.matched_item_name}>{item.matched_item_name}</option>
                        {catalog.map(c => (
                          <option key={c.id} value={c.name}>
                            {c.name} ({c.category})
                          </option>
                        ))}
                      </select>
                    </div>

                    <div className="grid grid-cols-3 gap-2 text-xs">
                      <div>
                        <label className="text-slate-500 block">Qty/Kg</label>
                        <input
                          type="number"
                          step="0.001"
                          value={item.qty_or_kg}
                          onChange={e => {
                            const qty = parseFloat(e.target.value) || 0;
                            const updated = [...draftBill.items];
                            updated[idx] = {
                              ...item,
                              qty_or_kg: qty,
                              total_value: Number((qty * item.unit_rate).toFixed(2))
                            };
                            setDraftBill({ ...draftBill, items: updated });
                          }}
                          className="w-full font-bold bg-white border border-slate-300 rounded px-2 py-1"
                        />
                      </div>
                      <div>
                        <label className="text-slate-500 block">Rate (₹/unit)</label>
                        <input
                          type="number"
                          step="0.01"
                          value={item.unit_rate}
                          onChange={e => {
                            const rate = parseFloat(e.target.value) || 0;
                            const updated = [...draftBill.items];
                            updated[idx] = {
                              ...item,
                              unit_rate: rate,
                              total_value: Number((item.qty_or_kg * rate).toFixed(2))
                            };
                            setDraftBill({ ...draftBill, items: updated });
                          }}
                          className="w-full font-bold bg-white border border-slate-300 rounded px-2 py-1"
                        />
                      </div>
                      <div>
                        <label className="text-slate-500 block">Value (₹)</label>
                        <input
                          type="number"
                          step="0.01"
                          value={item.total_value}
                          onChange={e => {
                            const val = parseFloat(e.target.value) || 0;
                            const updated = [...draftBill.items];
                            updated[idx] = { ...item, total_value: val };
                            setDraftBill({ ...draftBill, items: updated });
                          }}
                          className="w-full font-bold bg-white border border-slate-300 rounded px-2 py-1"
                        />
                      </div>
                    </div>
                  </div>
                ))}
              </div>

              <button
                onClick={() => {
                  setDraftBill({
                    ...draftBill,
                    items: [
                      ...draftBill.items,
                      {
                        hsn_code: '',
                        raw_particulars: '',
                        matched_item_name: catalog[0]?.name || '',
                        master_item_id: catalog[0]?.id || null,
                        qty_or_kg: 1,
                        unit_rate: 0,
                        total_value: 0
                      }
                    ]
                  });
                }}
                className="w-full py-2 border border-dashed border-emerald-600 text-emerald-700 font-bold rounded-xl text-sm"
              >
                + Add Bill Row
              </button>

              <div className="pt-2 border-t flex items-center justify-between">
                <div>
                  <span className="text-xs text-slate-500 block">Total Bill Value</span>
                  <span className="text-lg font-extrabold text-slate-900">
                    ₹{draftBill.items.reduce((s, i) => s + Number(i.total_value), 0).toFixed(2)}
                  </span>
                </div>
                <button
                  onClick={saveVerifiedBillToDb}
                  className="bg-emerald-600 text-white font-bold px-5 py-3 rounded-xl text-sm shadow-md"
                >
                  Save Verified Bill ✓
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {activeTab === 'analysis' && (
        <div className="p-3 space-y-4 flex-1">
          {!analysis.currentBill ? (
            <div className="bg-white p-6 rounded-2xl border border-slate-200 text-center space-y-2">
              <BarChart3 className="w-12 h-12 text-slate-300 mx-auto" />
              <h3 className="font-bold text-base text-slate-800">No Bill Found for {selectedMonth}</h3>
              <p className="text-xs text-slate-500">
                Upload a bill in the "Scan Bill" tab or change the month selector at the top right to view saved bills.
              </p>
            </div>
          ) : (
            <>
              <div className="grid grid-cols-2 gap-2.5">
                <div className="bg-white p-3.5 rounded-2xl border border-slate-200">
                  <span className="text-xs text-slate-500 font-medium">Total Spent ({selectedMonth})</span>
                  <p className="text-xl font-extrabold text-slate-900 mt-0.5">
                    ₹{analysis.currentBill.total_amount}
                  </p>
                  {analysis.previousBill && (
                    <p className="text-xs font-semibold text-slate-600 mt-1">
                      Prev ({analysis.previousBill.month_year}): ₹{analysis.previousBill.total_amount}
                    </p>
                  )}
                </div>
                <div className="bg-emerald-50 p-3.5 rounded-2xl border border-emerald-200">
                  <span className="text-xs text-emerald-800 font-medium">Saved on MRP</span>
                  <p className="text-xl font-extrabold text-emerald-700 mt-0.5">
                    ₹{analysis.currentBill.total_savings}
                  </p>
                  <p className="text-xs text-emerald-700 mt-1">
                    {analysis.currentBill.items.length} items billed
                  </p>
                </div>
              </div>

              <div className="bg-white p-4 rounded-2xl border border-slate-200 space-y-2.5">
                <div className="flex items-center gap-2 text-red-600 font-bold text-sm">
                  <TrendingUp className="w-5 h-5" />
                  <span>Price Shoot Up (vs Previous Bill)</span>
                </div>
                {analysis.priceShotUp.length === 0 ? (
                  <p className="text-xs text-slate-500">
                    {analysis.previousBill
                      ? 'No item unit-rate increases compared to previous bill.'
                      : 'Upload at least two months of bills to compare unit rate increases.'}
                  </p>
                ) : (
                  analysis.priceShotUp.map((it, i) => (
                    <div
                      key={i}
                      className="flex items-center justify-between p-2.5 bg-red-50/70 rounded-xl border border-red-200"
                    >
                      <div>
                        <p className="font-bold text-sm text-slate-900">{it.name}</p>
                        <p className="text-xs text-slate-600">
                          ₹{it.oldRate}/unit → <b>₹{it.newRate}/unit</b>
                        </p>
                      </div>
                      <span className="bg-red-600 text-white text-xs font-bold px-2.5 py-1 rounded-lg">
                        +₹{it.diff} (+{it.pct}%)
                      </span>
                    </div>
                  ))
                )}
              </div>

              <div className="bg-white p-4 rounded-2xl border border-slate-200 space-y-2.5">
                <div className="flex items-center gap-2 text-emerald-700 font-bold text-sm">
                  <TrendingDown className="w-5 h-5" />
                  <span>Price Declined (vs Previous Bill)</span>
                </div>
                {analysis.priceDeclined.length === 0 ? (
                  <p className="text-xs text-slate-500">
                    {analysis.previousBill
                      ? 'No item unit-rate drops compared to previous bill.'
                      : 'Upload at least two months of bills to compare unit rate drops.'}
                  </p>
                ) : (
                  analysis.priceDeclined.map((it, i) => (
                    <div
                      key={i}
                      className="flex items-center justify-between p-2.5 bg-emerald-50 rounded-xl border border-emerald-200"
                    >
                      <div>
                        <p className="font-bold text-sm text-slate-900">{it.name}</p>
                        <p className="text-xs text-slate-600">
                          ₹{it.oldRate}/unit → <b>₹{it.newRate}/unit</b>
                        </p>
                      </div>
                      <span className="bg-emerald-600 text-white text-xs font-bold px-2.5 py-1 rounded-lg">
                        -₹{it.diff} (-{it.pct}%)
                      </span>
                    </div>
                  ))
                )}
              </div>

              <div className="bg-white p-4 rounded-2xl border border-slate-200 space-y-2.5">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2 text-amber-700 font-bold text-sm">
                    <ShoppingCart className="w-5 h-5" />
                    <span>Purchased Extra (Not in Planned List)</span>
                  </div>
                  <span className="text-xs font-bold text-amber-800 bg-amber-100 px-2 py-0.5 rounded-md">
                    {analysis.purchasedExtra.length} items
                  </span>
                </div>
                {analysis.purchasedExtra.length === 0 ? (
                  <p className="text-xs text-slate-500">All billed items were on the planned list.</p>
                ) : (
                  <div className="space-y-1.5 max-h-60 overflow-y-auto">
                    {analysis.purchasedExtra.map((it, i) => (
                      <div
                        key={i}
                        className="flex items-center justify-between p-2 bg-amber-50/60 rounded-lg border border-amber-200 text-xs"
                      >
                        <div>
                          <span className="font-bold text-slate-800">{it.matched_item_name}</span>
                          <span className="text-slate-500 ml-1">
                            ({it.qty_or_kg} × ₹{it.unit_rate})
                          </span>
                        </div>
                        <span className="font-bold text-slate-900">₹{it.total_value}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              <div className="bg-white p-4 rounded-2xl border border-slate-200 space-y-2.5">
                <div className="flex items-center gap-2 text-slate-700 font-bold text-sm">
                  <AlertCircle className="w-5 h-5 text-slate-600" />
                  <span>Not Purchased (In List, Missing on Bill)</span>
                </div>
                {analysis.notPurchased.length === 0 ? (
                  <p className="text-xs text-slate-500">All planned items for {selectedMonth} were purchased.</p>
                ) : (
                  <div className="space-y-1.5">
                    {analysis.notPurchased.map((it, i) => (
                      <div
                        key={i}
                        className="flex items-center justify-between p-2 bg-slate-100 rounded-lg text-xs"
                      >
                        <span className="font-bold text-slate-800">{it.item_name}</span>
                        <span className="text-slate-600 font-semibold">
                          Planned: {it.quantity} {it.unit}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </>
          )}

          {savedBills.length > 0 && (
            <div className="bg-white p-4 rounded-2xl border border-slate-200 space-y-2">
              <h4 className="font-bold text-xs text-slate-500 uppercase tracking-wider">Saved Bills History</h4>
              {savedBills.map(b => (
                <div
                  key={b.id}
                  className="flex items-center justify-between p-2.5 rounded-xl border border-slate-200 text-xs"
                >
                  <div
                    onClick={() => setSelectedMonth(b.month_year)}
                    className="cursor-pointer flex-1"
                  >
                    <p className="font-bold text-slate-900">
                      {b.store_name} ({b.bill_date})
                    </p>
                    <p className="text-slate-500">
                      {b.items.length} items • Total: ₹{b.total_amount}
                    </p>
                  </div>
                  <button
                    onClick={() => deleteSavedBill(b.id)}
                    className="p-1.5 text-red-500 hover:bg-red-50 rounded-lg"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {showAddModal && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
          <div className="bg-white w-full max-w-sm rounded-2xl p-5 space-y-4 shadow-xl">
            <h3 className="text-base font-bold text-slate-900">Add Item to Master Catalog</h3>
            <div>
              <label className="text-xs font-bold text-slate-600 block mb-1">Item Name</label>
              <input
                type="text"
                placeholder="e.g., Kashmiri Mirch Powder"
                value={newItemName}
                onChange={e => setNewItemName(e.target.value)}
                className="w-full border border-slate-300 rounded-xl px-3 py-2.5 text-base"
              />
            </div>
            <div>
              <label className="text-xs font-bold text-slate-600 block mb-1">Category</label>
              <select
                value={newItemCategory}
                onChange={e => setNewItemCategory(e.target.value)}
                className="w-full border border-slate-300 rounded-xl px-3 py-2.5 text-sm font-semibold"
              >
                {categories
                  .filter(c => c !== 'All')
                  .map(c => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
              </select>
            </div>
            <div>
              <label className="text-xs font-bold text-slate-600 block mb-1">Default Unit</label>
              <select
                value={newItemUnit}
                onChange={e => setNewItemUnit(e.target.value)}
                className="w-full border border-slate-300 rounded-xl px-3 py-2.5 text-sm font-semibold"
              >
                {UNITS.map(u => (
                  <option key={u} value={u}>
                    {u}
                  </option>
                ))}
              </select>
            </div>
            <div className="flex gap-2 pt-2">
              <button
                onClick={() => setShowAddModal(false)}
                className="flex-1 py-2.5 bg-slate-100 text-slate-700 font-bold rounded-xl text-sm"
              >
                Cancel
              </button>
              <button
                onClick={handleAddCustomMasterItem}
                className="flex-1 py-2.5 bg-emerald-600 text-white font-bold rounded-xl text-sm"
              >
                Save Item
              </button>
            </div>
          </div>
        </div>
      )}

      <nav className="fixed bottom-0 left-1/2 -translate-x-1/2 w-full max-w-md bg-white border-t border-slate-200 grid grid-cols-4 py-1.5 z-40 shadow-lg">
        <button
          onClick={() => setActiveTab('select')}
          className={`flex flex-col items-center py-1.5 ${
            activeTab === 'select' ? 'text-emerald-700 font-bold' : 'text-slate-500'
          }`}
        >
          <CheckSquare className="w-5 h-5" />
          <span className="text-xs mt-1">1. Select</span>
        </button>

        <button
          onClick={() => setActiveTab('final')}
          className={`flex flex-col items-center py-1.5 relative ${
            activeTab === 'final' ? 'text-emerald-700 font-bold' : 'text-slate-500'
          }`}
        >
          <ShoppingCart className="w-5 h-5" />
          {monthlyItems.length > 0 && (
            <span className="absolute top-0.5 right-6 bg-emerald-600 text-white text-[10px] font-bold px-1.5 rounded-full">
              {monthlyItems.length}
            </span>
          )}
          <span className="text-xs mt-1">2. Final List</span>
        </button>

        <button
          onClick={() => setActiveTab('scan')}
          className={`flex flex-col items-center py-1.5 ${
            activeTab === 'scan' ? 'text-emerald-700 font-bold' : 'text-slate-500'
          }`}
        >
          <ScanLine className="w-5 h-5" />
          <span className="text-xs mt-1">3. Scan Bill</span>
        </button>

        <button
          onClick={() => setActiveTab('analysis')}
          className={`flex flex-col items-center py-1.5 ${
            activeTab === 'analysis' ? 'text-emerald-700 font-bold' : 'text-slate-500'
          }`}
        >
          <BarChart3 className="w-5 h-5" />
          <span className="text-xs mt-1">4. Analysis</span>
        </button>
      </nav>
    </div>
  );
}