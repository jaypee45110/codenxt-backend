const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const policyPath = path.join(__dirname, 'docs/architecture/COAS-vertical-isolation-policy.md');
const policy = fs.readFileSync(policyPath, 'utf8');
const normalized = policy.toLowerCase();

function assertIncludesAll(label, terms) {
  for (const term of terms) {
    assert.ok(
      normalized.includes(term.toLowerCase()),
      `${label} should mention ${term}`
    );
  }
}

test('COAS Vertical Isolation Policy covers mandatory gate areas', () => {
  assertIncludesAll('purpose', [
    'purpose',
    'platform-wide policy',
    'no vertical is pilot-ready until the isolation gate is green',
  ]);

  assertIncludesAll('isolation layers', [
    'brand',
    'UI',
    'API',
    'runtime',
    'persistence',
    'reports',
    'analytics',
    'providers',
    'redemption',
    'testing',
    'documentation',
  ]);

  assertIncludesAll('brand isolation', [
    'names',
    'logos',
    'iconography',
    'colors',
    'language',
    'terminology',
    'marketing copy',
  ]);

  assertIncludesAll('copy isolation', [
    'hero',
    'checkout',
    'ready',
    'dashboard',
    'join',
    'claim',
    'report labels',
    'buttons',
    'placeholders',
    'alt text',
    'PDF',
    'CSV',
    'email',
    'SMS',
    'push',
  ]);

  assertIncludesAll('runtime isolation', [
    'event resolution',
    'Audience Entry',
    'Interaction',
    'Routing',
    'Reward Assignment',
    'Persistence',
    'Reports',
    'Redemption',
    'Analytics',
    'must not guess a vertical',
  ]);

  assertIncludesAll('event resolution', [
    'eventCode + vertical',
    'Never resolve by `eventCode` alone for explicit vertical requests',
  ]);

  assertIncludesAll('API contract isolation', [
    'allowed',
    'forbidden',
    'public responses',
    'COAS internals',
  ]);

  assertIncludesAll('reward isolation', [
    'categories',
    'reward names',
    'reward rules',
    'reward lifecycle',
    'no cross-vertical reuse',
  ]);

  assertIncludesAll('report isolation', [
    'event_code + vertical',
    'Read helpers must filter by vertical',
    'mixed rows',
    'mixed metrics',
  ]);

  assertIncludesAll('database isolation', [
    'shared tables',
    'Queries must filter by vertical',
  ]);

  assertIncludesAll('provider isolation', [
    'Providers produce Audience Entry only',
    'provider adapters must not know rewards',
  ]);

  assertIncludesAll('COAS internal isolation', [
    'AudienceEntry',
    'AudienceIntent',
    'Interaction',
    'RoutingOutcome',
    'AudienceContext',
    'RewardAssignment',
    'PersistenceDecision',
    'Outbox',
    'State Machine',
    'must not be exposed publicly',
  ]);

  assertIncludesAll('frontend isolation', [
    'No cross-vertical copy',
    'No cross-vertical reward/category terminology',
    'All languages checked',
  ]);

  assertIncludesAll('shared components', [
    'Shared UI components are allowed',
    'Shared semantics are forbidden',
  ]);

  assertIncludesAll('legacy compatibility', [
    'explicit compatibility layer',
    'no implicit runtime aliasing',
  ]);

  assertIncludesAll('testing gate', [
    'Event collision',
    'Report collision',
    'Scan collision',
    'Reward collision',
    'Copy collision',
    'Translation collision',
    'Provider collision',
    'Redemption collision',
    'Dashboard collision',
    'Hero collision',
    'Checkout collision',
    'Join collision',
    'PDF collision',
    'CSV collision',
    'API collision',
    'DB collision',
  ]);

  assertIncludesAll('CI gate', [
    'PR cannot merge if the Isolation Gate fails',
  ]);

  assertIncludesAll('onboarding checklist', [
    'Namespace',
    'Routes',
    'Rewards',
    'Reports',
    'Copy',
    'Providers',
    'Redemption',
    'Tests',
    'Documentation',
    'Isolation gate green',
  ]);

  assertIncludesAll('canonical ownership', [
    'Terminology',
    'UI copy',
    'Reward categories',
    'Report contract',
    'API contract',
    'Test data',
    'Documentation',
    'explicit compatibility contract',
  ]);
});
