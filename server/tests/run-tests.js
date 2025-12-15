const assert = require('assert');
const { issueToken, validateToken } = require('../src/domain/tokenService');
const { generateRunWip, generateWfnWip } = require('../src/domain/exportService');
const { isExcluded } = require('../src/domain/exclusionsService');
const { RuleRegistry, numericParam } = require('../src/domain/rulesEngine');
const { IdempotencyService } = require('../src/domain/idempotencyService');
const {
  testTokenStoreIsPersistent,
  testApprovalFirstWriterWins,
  testRerunCreatesNewRunAndTokens,
  testInvalidTokenTriggersFailure,
} = require('./approvalTokens.test');
const { testEmailProviderUsesSmtpSettings } = require('./providers/emailProvider.test');
const {
  testBuildsExpectedUrl,
  testFetchesToastDataWithAuthAndMapping,
  testFetchToastDataHandlesFailures,
} = require('./providers/toastProvider.test');
const {
  testFetchVitalsReadsFromAirtable,
  testVitalsMissingRequiredFieldFails,
  testFetchPayrollCalendarReadsFromAirtable,
  testPayrollCalendarMissingFieldFails,
} = require('./providers/airtableProviders.test');

function testTokenLifecycle() {
  const token = issueToken({ action: 'approve', ttlMinutes: 0.001 });
  const validation = validateToken(token);
  assert.equal(validation.valid, true, 'token should be valid initially');
  const past = new Date(Date.now() + 60);
  const expired = validateToken(token, past);
  assert.equal(expired.valid, false, 'token should expire');
}

function testExportContracts() {
  const runCsv = generateRunWip([{ batchId: '', companyCode: 'RUN', fileNumber: '123', lastName: 'Doe', firstName: 'Jane', regHours: '10', otHours: '2', payRate: '15', tips: '5' }]);
  const expectedRun = 'Batch ID,Company Code,File #,Employee,Reg Hours,OT Hours,Pay Rate,Tips\n,RUN,123,Doe, Jane,10,2,15,5';
  assert.equal(runCsv, expectedRun, 'RUN export must match contract');
  let threw = false;
  try { generateWfnWip([], null); } catch (e) { threw = true; }
  assert.equal(threw, true, 'WFN export should fail on missing co code');
  const wfnCsv = generateWfnWip([{ fileNumber: '321', lastName: 'Smith', firstName: 'John' }], 'CO1');
  const expectedWfn = 'BATCH ID,CO CODE,FILE #,EMPLOYEE,REG HRS,OT HRS,PAY RATE,TIPS\n,CO1,321,Smith, John,,,,';
  assert.equal(wfnCsv, expectedWfn, 'WFN export contract format');
}

function testExclusions() {
  const exclusions = [{ toast_employee_id: 'E1', effective_from: '2024-01-01', effective_to: '2024-01-31', scope_flags: { payroll: true } }];
  assert.equal(isExcluded(exclusions, 'E1', new Date('2024-01-15'), 'payroll'), true, 'should exclude within window');
  assert.equal(isExcluded(exclusions, 'E1', new Date('2024-02-01'), 'payroll'), false, 'should not exclude outside window');
}

function testRuleValidation() {
  const registry = new RuleRegistry();
  registry.register('OT_THRESHOLD', { paramsSchema: numericParam('threshold'), run: () => ({}) });
  registry.validateConfig('OT_THRESHOLD', { threshold: 40 });
  let failed = false;
  try { registry.validateConfig('OT_THRESHOLD', { threshold: 'abc' }); } catch (e) { failed = true; }
  assert.equal(failed, true, 'numeric rule must reject invalid param');
}

function testIdempotency() {
  const svc = new IdempotencyService();
  assert.equal(svc.check('email', 'k1'), false);
  assert.equal(svc.record('email', 'k1'), true);
  assert.equal(svc.record('email', 'k1'), false, 'duplicate not allowed');
  assert.equal(svc.check('email', 'k1'), true, 'key should be stored');
}

async function runAll() {
  const tests = [
    testTokenLifecycle,
    testExportContracts,
    testExclusions,
    testRuleValidation,
    testIdempotency,
    testTokenStoreIsPersistent,
    testApprovalFirstWriterWins,
    testRerunCreatesNewRunAndTokens,
    testInvalidTokenTriggersFailure,
    testEmailProviderUsesSmtpSettings,
    testBuildsExpectedUrl,
    testFetchesToastDataWithAuthAndMapping,
    testFetchToastDataHandlesFailures,
    testFetchVitalsReadsFromAirtable,
    testVitalsMissingRequiredFieldFails,
    testFetchPayrollCalendarReadsFromAirtable,
    testPayrollCalendarMissingFieldFails,
  ];
  for (const fn of tests) {
    await fn();
    console.log(`✔ ${fn.name}`);
  }
  console.log('All tests passed');
}

runAll();
