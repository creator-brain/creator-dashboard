import test from 'node:test'
import assert from 'node:assert/strict'
import { searchDeals } from '../src/model.js'

const deals = [
  { id: '1', brand: 'Acme Studio', agency: '', product: '', next: '', fee: '', status: 'Awaiting brand', source: 'Email', type: ['UGC'], platforms: [] },
  { id: '2', brand: 'Acme', agency: '', product: '', next: '', fee: '', status: 'Completed', source: 'Email', type: ['UGC'], platforms: [] },
  { id: '3', brand: 'Live Co', agency: 'Acme Agency', product: '', next: '', fee: '', status: 'Action needed', source: 'Instagram', type: ['Livestream'], platforms: ['Live'] },
]

test('search returns one direct match as one result', () => {
  assert.deepEqual(searchDeals(deals, 'live co').map(deal => deal.id), ['3'])
})

test('search includes both tabs and archive, ranking brand matches first', () => {
  assert.deepEqual(searchDeals(deals, ' ACME ').map(deal => deal.id), ['2', '1', '3'])
})

test('search returns zero results for no match', () => {
  assert.deepEqual(searchDeals(deals, 'missing'), [])
  assert.deepEqual(searchDeals(deals, '   '), [])
})
