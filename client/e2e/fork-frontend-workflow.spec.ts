import { expect, test } from '@playwright/test'
import { installAppShellApiMocks } from './support/appShellMocks'
import { installSearchRuleWorkflowApiMocks } from './support/searchRuleMocks'
import type { SearchRulePayload } from '../src/features/search/rule/query'

test('edits and reloads fork rule fields without losing channel selections or Bangumi ID', async ({
  page,
}, testInfo) => {
  await installAppShellApiMocks(page, { enableBroadcastWaveNavigation: true })
  await installSearchRuleWorkflowApiMocks(page)
  await page.route('**/api/config', (route) =>
    route.fulfill({
      json: {
        broadcast: {
          GR: true,
          'GR-ALT': true,
          BS: true,
          BS4K: true,
          CS: false,
          SKY: false,
          NW1: true,
          NW40: true,
        },
        recorded: ['archive-root'],
        encode: [],
        isEnableEncode: false,
      },
    }),
  )
  let rule = {
    id: 6201,
    isTimeSpecification: false,
    bangumiId: 12345,
    searchOption: {
      keyword: 'Synthetic Fork Rule',
      'GR-ALT': true,
      NW1: true,
      NW40: true,
      times: [{ week: 127 }],
    },
    reserveOption: {
      enable: true,
      allowEndLack: true,
      removeDataBroadcast: true,
      avoidDuplicate: false,
      periodToAvoidDuplicate: null,
    },
    saveOption: { parentDirectoryName: null, directory: null, recordedFormat: null },
  }
  let updates = 0
  await page.route('**/api/rules/6201', async (route) => {
    if (route.request().method() === 'PUT') {
      const payload = route.request().postDataJSON()
      expect(payload).toMatchObject({
        bangumiId: updates === 0 ? 12345 : null,
        searchOption: { 'GR-ALT': true, NW1: true, NW40: true },
        reserveOption: { removeDataBroadcast: false },
      })
      rule = { ...rule, ...payload }
      updates += 1
      await route.fulfill({ status: 204 })
    } else {
      await route.fulfill({ json: rule })
    }
  })
  await page.goto('/#/search?rule=6201')
  for (const name of ['GR-ALT', 'NW1', 'NW40']) {
    await expect(page.getByRole('checkbox', { name, exact: true })).toBeChecked()
  }
  await expect(page.getByRole('checkbox', { name: 'データ放送を削除', exact: true })).toBeChecked()
  await page.getByRole('checkbox', { name: 'データ放送を削除', exact: true }).uncheck()
  await page.getByRole('button', { name: '更新', exact: true }).click()
  await expect.poll(() => updates).toBe(1)
  await page.reload()
  await expect(
    page.getByRole('checkbox', { name: 'データ放送を削除', exact: true }),
  ).not.toBeChecked()
  await expect(page.getByRole('checkbox', { name: 'NW40', exact: true })).toBeChecked()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  )
  await page.screenshot({ path: testInfo.outputPath('fork-rule.png'), fullPage: true })
  const bangumiInput = page.getByLabel('Bgm ID', { exact: true })
  await expect(bangumiInput).toHaveValue('12345')
  await bangumiInput.fill('')
  await page.getByRole('button', { name: '更新', exact: true }).click()
  await expect.poll(() => updates).toBe(2)
  await page.reload()
  await expect(bangumiInput).toHaveValue('')
})

test('previews Bangumi candidates, recovers a scan failure, and creates only after confirmation', async ({
  page,
}, testInfo) => {
  await page.clock.setFixedTime(new Date('2026-10-22T09:00:00+09:00'))
  await installAppShellApiMocks(page)
  await installSearchRuleWorkflowApiMocks(page)
  const created: SearchRulePayload[] = []
  let collectionRequests = 0
  await page.route('https://api.bgm.tv/v0/users/*/collections*', async (route) => {
    collectionRequests += 1
    if (collectionRequests === 1) {
      await route.fulfill({ status: 503, json: { error: 'unavailable' } })
      return
    }
    await route.fulfill({
      json: {
        total: 1,
        data: [
          {
            subject: {
              id: 12345,
              name: 'Synthetic Autumn Anime',
              name_cn: '秋季测试动画',
              date: '2026-10-01',
            },
          },
        ],
      },
    })
  })
  await page.route('https://api.bgm.tv/v0/subjects/*', (route) => route.fulfill({ json: {} }))
  await page.route('https://api.jikan.moe/**', (route) => route.fulfill({ json: { data: [] } }))
  await page.route('**/api/rules?*', (route) =>
    route.fulfill({
      json: {
        rules: created.map((rule, index) => ({ ...rule, id: 9001 + index, reservesCnt: 1 })),
        total: created.length,
      },
    }),
  )
  await page.route('**/api/rules', async (route) => {
    if (route.request().method() === 'POST') {
      const payload = route.request().postDataJSON() as SearchRulePayload
      expect(payload).toMatchObject({
        bangumiId: 12345,
        reserveOption: { removeDataBroadcast: true, avoidDuplicate: true },
      })
      expect(JSON.stringify(payload)).not.toContain('synthetic-bangumi-account')
      created.push(payload)
      await route.fulfill({ json: { ruleId: 9000 + created.length } })
    } else await route.fulfill({ json: { rules: [], total: 0 } })
  })
  await page.route('**/api/schedules/search', (route) =>
    route.fulfill({
      json: [
        {
          id: 6101,
          name: 'Synthetic Autumn Anime',
          channelId: 4101,
          startAt: Date.parse('2026-10-23T00:30:00+09:00'),
          endAt: Date.parse('2026-10-23T01:00:00+09:00'),
        },
      ],
    }),
  )
  await page.goto('/#/rule')
  const importer = page.getByTestId('bangumi-quarter-import')
  const scan = importer.getByRole('button', { name: '番組表を照合', exact: true })
  await expect(scan).toBeDisabled()
  await importer.getByLabel('Bangumi アカウント').fill('synthetic-bangumi-account')
  await scan.click()
  await expect(importer.getByRole('alert')).toContainText('503')
  await expect(scan).toBeEnabled()
  await scan.click()
  await expect(importer.getByRole('alert')).toHaveCount(0)
  const confirm = importer.getByRole('button', { name: '選択した 1 件のルールを作成' })
  await expect(confirm).toBeEnabled()
  expect(created).toHaveLength(0)
  await importer.locator('summary').filter({ hasText: 'Synthetic Autumn Anime' }).click()
  const directory = importer.getByLabel('保存先', { exact: true })
  await directory.fill('../invalid')
  await expect(confirm).toBeDisabled()
  await directory.fill('2026-10/synthetic-anime')
  await expect(confirm).toBeEnabled()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  )
  await page.screenshot({ path: testInfo.outputPath('bangumi-preview.png'), fullPage: true })
  await confirm.click()
  await expect.poll(() => created.length).toBe(1)
  await expect(importer.getByText('作成済み: ルール ID: 9001')).toBeVisible()
  await expect(importer.getByRole('button', { name: /選択した 0 件/ })).toBeDisabled()
  await page.reload()
  await expect(importer.getByLabel('Bangumi アカウント')).toHaveValue('synthetic-bangumi-account')
  await expect(page.getByTestId('rule-item-9001')).toBeVisible()
  await scan.click()
  await expect(importer.getByText(/ルール登録済み/)).toBeVisible()
  await expect(importer.getByRole('button', { name: /選択した 0 件/ })).toBeDisabled()
  expect(created).toHaveLength(1)
})
