<script setup>
import { computed, nextTick, onMounted, ref, watch } from 'vue';
import { api } from '../api';
import CompanyTable from './CompanyTable.vue';
import { dateLocale, pick, t } from '../i18n';
import { isNarrow } from '../viewport';
import Loading from './Loading.vue';

// params: { industry } - a TWSE industry code ('24'), '' for none picked
const props = defineProps({ params: { type: Object, default: () => ({}) } });
const emit = defineEmits(['open', 'navigate']);

const code = ref(props.params.industry || '');
const filter = ref('');
const error = ref(null);

watch(code, () => emit('navigate', { industry: code.value }));
// browser Back / Forward: the parent hands the URL state back down
watch(
  () => props.params,
  (p) => {
    if ((p.industry || '') !== code.value) code.value = p.industry || '';
  },
  { deep: true },
);

// ---------- industries ----------
const industry = ref(null);
const indFilter = ref('');
const openDivisions = ref(new Set());

const groups = computed(() => {
  if (!industry.value) return [];
  const q = indFilter.value.trim().toUpperCase();
  return industry.value.divisions
    .map((d) => {
      const codes = industry.value.codes
        .filter((c) => c.division === d.id && c.total)
        .filter((c) => !q || c.code.startsWith(q) || (c.zh || '').includes(q) || (c.title || '').toUpperCase().includes(q))
        .sort((a, b) => a.code.localeCompare(b.code));
      return { ...d, codes, total: codes.reduce((s, c) => s + c.total, 0) };
    })
    .filter((d) => d.codes.length);
});
const selected = computed(() => industry.value?.codes.find((c) => c.code === code.value) || null);

function toggleDivision(id) {
  const s = new Set(openDivisions.value);
  if (s.has(id)) s.delete(id);
  else s.add(id);
  openDivisions.value = s;
}

// ---------- company list ----------
const companies = ref(null);
const loadingCompanies = ref(false);

async function loadCompanies() {
  if (!code.value) {
    companies.value = null;
    return;
  }
  loadingCompanies.value = true;
  error.value = null;
  try {
    companies.value = await api.browseCompanies({ industry: code.value, limit: 5000 });
  } catch (e) {
    error.value = e.message;
    companies.value = null;
  } finally {
    loadingCompanies.value = false;
  }
}
watch(code, loadCompanies);

// latest-report scores for whatever is on screen (batched)
const scores = ref({});
async function loadScores(ciks) {
  const need = [...new Set(ciks.filter((c) => c && !(c in scores.value)))];
  for (let i = 0; i < need.length; i += 1500) {
    try {
      const r = await api.scores(need.slice(i, i + 1500));
      scores.value = { ...scores.value, ...r.scores };
    } catch {
      /* scores are decoration: ignore failures */
    }
  }
}
watch(companies, (c) => c && loadScores(c.companies.map((x) => x.cik)));

const visibleCompanies = computed(() => {
  if (!companies.value) return [];
  const q = filter.value.trim().toUpperCase();
  if (!q) return companies.value.companies;
  return companies.value.companies.filter((c) => c.name.includes(q) || (c.fullName || '').includes(q) || (c.nameEn || '').toUpperCase().includes(q) || c.ticker.startsWith(q));
});

// small screens: the list panel is a drawer above the content, closed once
// something is picked and reopened from the bar that names the pick
const sideOpen = ref(!code.value);
watch(code, (v) => {
  if (v && isNarrow.value) sideOpen.value = false;
});
const pickLabel = computed(() => (selected.value ? pick(selected.value, 'zh', 'title') : t('br.pickBar')));

onMounted(async () => {
  try {
    const r = await api.browseIndustry();
    industry.value = r;
    if (code.value) {
      openDivisions.value = new Set([r.codes.find((c) => c.code === code.value)?.division].filter(Boolean));
      nextTick(() => document.querySelector('.code.active')?.scrollIntoView({ block: 'center' }));
    } else openDivisions.value = new Set(['D']);
  } catch (err) {
    error.value = err.message;
  }
  loadCompanies();
});
</script>

<template>
  <div class="browse">
    <div class="tabs">
      <strong>{{ t('br.title') }}</strong>
      <span v-if="industry" class="muted small src">{{ t('br.dataSource', { date: new Date(industry.updatedAt).toLocaleDateString(dateLocale) }) }}</span>
    </div>
    <p v-if="error" class="error">{{ error }}</p>

    <button v-if="isNarrow" class="pickbar" :class="{ open: sideOpen }" @click="sideOpen = !sideOpen"><span class="caret">{{ sideOpen ? '▾' : '▸' }}</span> {{ pickLabel }}</button>

    <div class="layout">
      <aside v-show="!isNarrow || sideOpen" class="panel side">
        <input v-model="indFilter" type="text" :placeholder="t('br.industrySearch')" />
        <Loading v-if="!industry" small :text="t('br.loadingIndustry')" />
        <div v-for="d in groups" :key="d.id" class="division">
          <div class="division-head" @click="toggleDivision(d.id)">
            <span class="caret">{{ openDivisions.has(d.id) || indFilter ? '▾' : '▸' }}</span>
            {{ pick(d, 'zh', 'title') }} <span class="muted small">({{ d.total }})</span>
          </div>
          <div v-if="openDivisions.has(d.id) || indFilter" class="codes">
            <div v-for="c in d.codes" :key="c.code" class="code" :class="{ active: c.code === code }" :title="c.title" @click="code = c.code">
              <span class="mono">{{ c.code }}</span> {{ pick(c, 'zh', 'title') }}
              <span class="muted count">{{ c.total }}</span>
            </div>
          </div>
        </div>
      </aside>
      <main>
        <template v-if="selected">
          <div class="panel meta">
            <div>
              <strong>{{ pick(selected, 'zh', 'title') }}</strong>
              <div class="muted small">{{ t('br.industryCode', { code: selected.code }) }} · {{ selected.title }}</div>
            </div>
            <div class="options">
              <input v-model="filter" type="text" :placeholder="t('br.filterCompanies')" class="filter" />
              <span class="muted small">{{ t('companies', { n: visibleCompanies.length }) }}</span>
            </div>
          </div>
          <Loading v-if="loadingCompanies" :text="t('br.loadingCompanies')" />
          <CompanyTable v-else-if="companies" :companies="visibleCompanies" :show-industry="false" :scores="scores" @open="emit('open', $event)" />
        </template>
        <p v-else class="empty muted">{{ t('br.pickIndustry') }}</p>
      </main>
    </div>
  </div>
</template>

<style scoped>
.tabs {
  display: flex;
  gap: 6px;
  align-items: center;
  flex-wrap: wrap;
  margin-bottom: 12px;
}
.src {
  margin-left: auto;
}
.small {
  font-size: 12px;
}
.error {
  color: var(--neg);
  background: var(--neg-soft);
  padding: 8px 12px;
  border-radius: 6px;
}
.layout {
  display: grid;
  grid-template-columns: 340px 1fr;
  gap: 16px;
  align-items: start;
}
main {
  min-width: 0;
}
.side {
  position: sticky;
  top: 16px;
  max-height: calc(100vh - 32px);
  overflow: auto;
  padding: 12px;
}
.side input[type='text'] {
  width: 100%;
  margin-bottom: 8px;
}
.side label {
  display: block;
  margin-bottom: 8px;
}
.division-head {
  cursor: pointer;
  font-weight: 600;
  padding: 6px 4px;
  border-top: 1px solid var(--border);
  user-select: none;
}
.caret {
  display: inline-block;
  width: 14px;
  color: var(--muted);
}
.code,
.etf {
  display: flex;
  gap: 6px;
  align-items: baseline;
  padding: 4px 6px 4px 18px;
  cursor: pointer;
  border-radius: 4px;
  font-size: 13px;
}
.etf {
  padding-left: 6px;
}
.code:hover,
.etf:hover {
  background: var(--accent-soft);
}
.code.active,
.etf.active {
  background: var(--accent);
  color: var(--on-accent);
}
.code.active .muted,
.etf.active .muted {
  color: var(--accent-soft);
}
.code .count {
  margin-left: auto;
  font-size: 11px;
}
.mono {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}
.card {
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 10px 12px;
  margin-bottom: 8px;
  cursor: pointer;
}
.card:hover {
  border-color: var(--accent);
}
.card.active {
  border-color: var(--accent);
  background: var(--accent-soft);
}
.card-title {
  font-weight: 600;
}
.head {
  margin: 10px 0 4px;
  font-weight: 600;
}
.meta {
  display: flex;
  justify-content: space-between;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  padding: 10px 16px;
  margin-bottom: 12px;
}
.options {
  display: flex;
  gap: 12px;
  align-items: center;
}
.filter {
  width: 200px;
  padding: 5px 8px;
}
.empty {
  text-align: center;
  padding: 80px 0;
}
.wrap {
  overflow: auto;
  max-height: calc(100vh - 260px);
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--panel);
}
table {
  border-collapse: separate;
  border-spacing: 0;
  width: 100%;
}
th,
td {
  padding: 6px 10px;
  border-bottom: 1px solid var(--border);
  white-space: nowrap;
  text-align: left;
}
thead th {
  position: sticky;
  top: 0;
  background: var(--panel);
  z-index: 1;
  font-weight: 600;
  border-bottom: 2px solid var(--border);
  font-size: 13px;
}
.num {
  text-align: right;
  font-variant-numeric: tabular-nums;
}
.name {
  white-space: normal;
  min-width: 220px;
}
.row {
  cursor: pointer;
}
.row:hover td {
  background: var(--accent-soft);
}
.dim td {
  color: var(--muted);
}
td.star,
th.star {
  width: 28px;
  text-align: center;
  cursor: pointer;
  color: var(--muted);
  font-size: 15px;
}
td.star .on {
  color: var(--star);
}
tbody tr:nth-child(even) td {
  background: var(--row-alt);
}
.note {
  margin-top: 8px;
}
.pickbar {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  text-align: left;
  margin-bottom: 10px;
  font-weight: 600;
}
.pickbar.open {
  border-color: var(--accent);
}
@media (max-width: 1100px) {
  .layout {
    grid-template-columns: 1fr;
  }
  .side {
    position: static;
    max-height: 60vh;
  }
}
@media (max-width: 760px) {
  .tabs {
    flex-wrap: wrap;
  }
  .tabs .src {
    display: none;
  }
  .meta .options {
    flex-wrap: wrap;
  }
  .wrap {
    max-height: none;
  }
}
</style>
