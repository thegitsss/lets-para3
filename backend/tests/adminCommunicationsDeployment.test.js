const fs = require('fs');
const path = require('path');
const { parseYaml, validateDeploymentContract } = require('../scripts/check-render-blueprint');
const packageJson = require('../package.json');
const source = fs.readFileSync(path.resolve(__dirname, '../../render.yaml'), 'utf8');
const blueprint = () => parseYaml(source, 'render.yaml');
test('the prepared Blueprint includes executable communications and predeploy index commands', () => {
  const deployment = blueprint();
  expect(() => validateDeploymentContract(deployment)).not.toThrow();
  const worker = deployment.services.find(s => s.name === 'lets-para3-admin-communications');
  const script = worker.startCommand.split('npm run ')[1];
  expect(packageJson.scripts[script]).toContain('admin-communications-worker.js');
  expect(packageJson.scripts['admin:communications:indexes']).toContain('admin-communications-indexes.js');
});
test('communications secrets must stay outside the Blueprint', () => {
  const deployment = blueprint();
  deployment.services.find(s => s.name === 'lets-para3-admin-communications').envVars
    .find(v => v.key === 'SUPPORT_ZOHO_REFRESH_TOKEN').value = 'must-not-be-in-source';
  expect(() => validateDeploymentContract(deployment)).toThrow(/checked-in value/);
});
test('deployment cannot omit the communications uniqueness indexes or restart grace', () => {
  const deployment = blueprint();
  deployment.services[0].preDeployCommand = 'cd backend && npm run migrate:production:apply';
  expect(() => validateDeploymentContract(deployment)).toThrow(/preDeployCommand/);
  const next = blueprint();
  next.services.find(s => s.name === 'lets-para3-admin-communications').maxShutdownDelaySeconds = 30;
  expect(() => validateDeploymentContract(next)).toThrow(/maxShutdownDelaySeconds/);
});
