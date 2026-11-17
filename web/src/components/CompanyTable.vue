<script setup>
import { computed, ref } from 'vue';

import ScoreBadge from './ScoreBadge.vue';
import { isWatched, toggleWatch } from '../watchlist';
import { bigMoney, isZh, t } from '../i18n';

const props = defineProps({
  companies: { type: Array, required: true },
  showIndustry: { type: Boolean, default: true },
  scores: { type: Object, default: () => ({}) }, // cik -> score summary | null
});
const emit = defineEmits(['open']);

const sortKey = ref('marketCap');
const sortDir = ref(-1);

function sortBy(key) {
  if (sortKey.value === key) sortDir.value = -sortDir.value;
  else {
    sortKey.value = key;
    sortDir.value = key === 'name' || key === 'ticker' ? 1 : -1;
  }
}

const rows = computed(() => {
  const k = sortKey.value;
  const d = sortDir.value;
  const val = (c) => (k === 'score' ? props.scores[c.cik]?.score ?? null : c[k]);
  return [...props.companies].sort((a, b) => {
    const x = val(a) ?? (typeof val(b) === 'number' ? -Infinity : '');
    const y = val(b) ?? (typeof val(a) === 'number' ? -Infinity : '');
    if (x === y) return a.ticker.localeCompare(b.ticker);
    return (x < y ? -1 : 1) * d;
  });
});

const arrow = (k) => (sortKey.value === k ? (sortDir.value > 0 ? ' ▲' : ' ▼') : '');
</script>

<template>
  <div class="wrap">
    <table>
      <thead>
        <tr>
          <th class="star"></th>
          <th class="sortable" @click="sortBy('ticker')">{{ t('col.ticker') }}{{ arrow('ticker') }}</th>
          <th class="sortable" :title="t('col.scoreTitle')" @click="sortBy('score')">{{ t('col.score') }}{{ arrow('score') }}</th>
          <th class="sortable" @click="sortBy('name')">{{ t('col.company') }}{{ arrow('name') }}</th>
          <th v-if="showIndustry" class="sortable hide-p" @click="sortBy('industry')">{{ t('col.industry') }}{{ arrow('industry') }}</th>
          <th class="num sortable" @click="sortBy('marketCap')">{{ t('col.marketCap') }}{{ arrow('marketCap') }}</th>
          <th class="num sortable hide-p" @click="sortBy('capital')">{{ t('col.capital') }}{{ arrow('capital') }}</th>
          <th class="sortable hide-t" @click="sortBy('listedDate')">{{ t('col.listedDate') }}{{ arrow('listedDate') }}</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="c in rows" :key="c.cik" class="row" @click="emit('open', c)">
          <td class="star" @click.stop="toggleWatch(c)"><span :class="{ on: isWatched(c.cik) }" :title="isWatched(c.cik) ? t('watch.remove') : t('watch.add')">{{ isWatched(c.cik) ? '★' : '☆' }}</span></td>
          <td class="mono">
            <a :href="`?company=${c.ticker}`" @click.prevent>{{ c.ticker }}</a>
          </td>
          <td><ScoreBadge :score="scores[c.cik] ?? null" /></td>
          <td class="name">{{ c.name }}<span v-if="!isZh && c.nameEn" class="muted small"> · {{ c.nameEn }}</span><span v-if="c.foreign" class="tag" :title="t('company.foreign', { country: c.foreign })">{{ c.foreign.slice(0, 2) }}</span></td>
          <td v-if="showIndustry" class="small hide-p">
            <span v-if="c.industry">{{ (isZh ? c.industryZh || c.industryTitle : c.industryTitle || c.industryZh) || c.industry }}</span>
            <span v-else class="muted">—</span>
          </td>
          <td class="num">{{ bigMoney(c.marketCap) }}</td>
          <td class="num hide-p">{{ bigMoney(c.capital) }}</td>
          <td class="small muted hide-t">{{ c.listedDate || '—' }}</td>
        </tr>
      </tbody>
    </table>
    <p v-if="!companies.length" class="muted empty">{{ t('col.noCompanies') }}</p>
  </div>
</template>

<style scoped>
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
.sortable {
  cursor: pointer;
  user-select: none;
}
.sortable:hover {
  color: var(--accent);
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
tbody tr:nth-child(even) td {
  background: var(--row-alt);
}
.small {
  font-size: 12px;
}
.tiny {
  font-size: 10px;
}
.mono {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}
/* not "badge": that name would leak into ScoreBadge's root element through the scoped attribute */
.tag {
  display: inline-block;
  font-size: 10px;
  color: var(--accent);
  border: 1px solid var(--accent);
  border-radius: 3px;
  padding: 0 3px;
  margin-left: 4px;
  vertical-align: middle;
}
.warn {
  color: var(--neg);
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
.empty {
  padding: 24px;
  text-align: center;
}
@media (max-width: 760px) {
  .wrap {
    max-height: none;
  }
  th,
  td {
    padding: 5px 6px;
  }
  .name {
    min-width: 140px;
    font-size: 12px;
  }
}
</style>
