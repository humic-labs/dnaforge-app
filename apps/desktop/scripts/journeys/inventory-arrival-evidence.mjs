import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import path from 'node:path';

const button = (scope, name) => scope.getByRole('button', { name, exact: true });
const modal = (page) => page.getByRole('dialog', { name: 'Receive delivery', exact: true });
const field = (scope, name) => scope.getByRole('textbox', { name, exact: true });
const escaped = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const hash = (bytes) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;

function supplierPdf(lines) {
  const text = lines
    .map((line, index) => {
      const escapedLine = line
        .replaceAll('\\', '\\\\')
        .replaceAll('(', '\\(')
        .replaceAll(')', '\\)');
      return `${index ? '0 -18 Td ' : ''}(${escapedLine}) Tj`;
    })
    .join('\n');
  const stream = `BT\n/F1 12 Tf\n72 720 Td\n${text}\nET\n`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}endstream`,
  ];
  let body = '%PDF-1.4\n';
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(body));
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xrefOffset = Buffer.byteLength(body);
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  body += offsets
    .slice(1)
    .map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`)
    .join('');
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(body, 'utf8');
}

async function closeStock(page) {
  const close = button(page, 'Close stock details');
  if (await close.isVisible()) await close.click();
}
async function showStock(page, id) {
  await closeStock(page);
  await button(page, 'All stock').click();
  await page.getByTestId('inventory-stock-table').locator(`[data-stock-id="${id}"]`).click();
}
function arrivalOf(fixture, state) {
  const arrival = Object.values(state.arrivals).find(
    (item) => item.identity.arrivalId === fixture.arrivalEvidenceJourney.deliveryId
  );
  assert.ok(arrival, 'The PDF-backed delivery is recorded.');
  return arrival;
}
function assertStage(fixture, current, step, followingOperations = 0) {
  const proof = fixture.arrivalEvidenceJourney;
  assert.equal(current.state.schema, 'dnaforge.inventory.v22');
  assert.equal(current.state.revision, proof.initialRevision + step + followingOperations);
  assert.deepEqual(current.history.slice(0, proof.baselineHistory.length), proof.baselineHistory);
  for (const [id, stock] of Object.entries(proof.baselineStocks))
    assert.deepEqual(current.state.stocks[id], stock, 'Earlier stock is unchanged.');
  assert.deepEqual(current.state.validityFacts, proof.baselineValidityFacts);
  assert.deepEqual(current.state.openingObservations, proof.baselineOpeningObservations);
  assert.deepEqual(current.state.expectedDeliveries, proof.baselineExpectedDeliveries);
  assert.deepEqual(current.state.arrivalAllocations, proof.baselineArrivalAllocations);
  assert.deepEqual(current.state.reorderRules, proof.baselineReorderRules);
  if (!step) return;
  assertPdfFacts(fixture, current, step);
}
function assertPdfFacts(fixture, current, step) {
  const proof = fixture.arrivalEvidenceJourney;
  const arrival = arrivalOf(fixture, current.state);
  assert.equal(arrival.documents.length, 1);
  assert.equal(arrival.documents[0].mediaType, 'application/pdf');
  assert.deepEqual(arrival.documents[0].coverage, { kind: 'full' });
  assert.equal(arrival.documents[0].sha256, proof.pdfSha256);
  assert.equal(arrival.documents[0].byteLength, Buffer.from(proof.pdfBase64, 'base64').length);
  assert.equal(arrival.packages[0].packagingBatch, proof.packagingBatch);
  const component = arrival.components[0];
  assert.equal(component.choice.kind, 'identified');
  assert.equal(component.componentBatch, proof.componentBatch);
  assert.notEqual(component.componentBatch, arrival.packages[0].packagingBatch);
  assert.equal(component.choice.quantityBasis.kind, 'supplier-declared');
  assert.deepEqual(component.receivedQuantity, { kind: 'known', value: '2000000', unit: 'ng' });
  assert.deepEqual(current.state.stocks[component.target.stockId].quantity, {
    kind: 'known',
    value: step >= 3 ? '1900000' : '2000000',
    unit: 'ng',
  });
  assert.equal(current.state.stocks[component.target.stockId].quality, 'usable');
  const lot = current.state.lots[component.target.lotId];
  assert.equal(lot.controls.kind, 'managed');
  assert.equal(lot.controls.assessment.value, step >= 2 ? 'released' : 'unassessed');
  assert.equal(arrival.claims.length, 3);
  for (const claim of arrival.claims) {
    assert.deepEqual(claim.subject, { kind: 'component', componentKey: component.key });
    assert.equal(claim.verification, 'operator-cited-pdf-region');
    assert.equal(claim.selection.expectedSha256, proof.pdfSha256);
    assert.equal(claim.selection.locator.kind, 'pdf-region');
    assert.equal(claim.selection.locator.page1Based, 1);
  }
  const quantity = arrival.claims.find((claim) => claim.claim.kind === 'quantity');
  assert.ok(quantity);
  assert.deepEqual(quantity.claim, { kind: 'quantity', valueLexeme: '2', unitText: 'mg' });
  assert.equal(quantity.key, component.choice.quantityBasis.claimKey);
  assert.equal(quantity.selection.verbatim, proof.quantityQuote);
  assert.equal(
    arrival.claims.find((claim) => claim.claim.kind === 'supplier-qc')?.selection.verbatim,
    proof.qcQuote
  );
  assert.equal(
    arrival.claims.find((claim) => claim.claim.kind === 'date-or-condition')?.selection.verbatim,
    proof.dateQuote
  );
  const accepted = current.history[proof.initialRevision].request;
  assert.equal(accepted.kind, 'receive-arrival');
  const source = JSON.parse(accepted.sourceText);
  assert.equal(source.documents[0].body.encoding, 'base64');
  assert.equal(source.documents[0].body.value, proof.pdfBase64);
}

export async function runInventoryArrivalEvidenceJourney(ctx) {
  const current = await ctx.inventoryRead(ctx.fixture.scope);
  assert.equal(current.state.schema, 'dnaforge.inventory.v22');
  assert.deepEqual(current.state, ctx.fixture.state);
  assert.deepEqual(current.history, ctx.fixture.history);
  const material = ctx.fixture.arrivalJourney?.material ?? ctx.fixture.stockroomJourney?.material;
  assert.ok(material, 'Use the existing scientific material from the owned profile.');
  const tag = randomUUID().slice(0, 8);
  const proof = {
    initialRevision: current.state.revision,
    completedStep: 0,
    baselineStocks: current.state.stocks,
    baselineHistory: current.history,
    baselineValidityFacts: current.state.validityFacts,
    baselineOpeningObservations: current.state.openingObservations,
    baselineExpectedDeliveries: current.state.expectedDeliveries,
    baselineArrivalAllocations: current.state.arrivalAllocations,
    baselineReorderRules: current.state.reorderRules,
    deliveryId: `pdf-${tag}`,
    componentLabel: `PDF ${tag} reagent`,
    vesselName: `PDF ${tag} vial`,
    lotName: `PDF ${tag} supplier lot`,
    packageLabel: `PDF ${tag} shipment`,
    packagingBatch: `PACK-${tag}`,
    componentBatch: `REAGENT-${tag}`,
    material,
    quantityQuote: 'Supplied reagent amount: 2 mg',
    qcQuote: 'Supplier QC: pass',
    dateQuote: 'Supplier date statement: July 2027; interpretation not established',
  };
  const bytes = supplierPdf([
    'Synthetic original supplier certificate',
    `Packaging batch: ${proof.packagingBatch}`,
    `Reagent component batch: ${proof.componentBatch}`,
    proof.quantityQuote,
    proof.qcQuote,
    proof.dateQuote,
  ]);
  proof.pdfBase64 = bytes.toString('base64');
  proof.pdfSha256 = hash(bytes);
  return finish({ ...ctx, fixture: { ...ctx.fixture, arrivalEvidenceJourney: proof } });
}

export async function runInventoryArrivalEvidenceResume(ctx) {
  assert.equal(ctx.fixture.resumePhase, 'arrival-evidence-after-accepted-stage');
  const current = await ctx.inventoryRead(ctx.fixture.scope);
  assert.deepEqual(current.state, ctx.fixture.state);
  assert.deepEqual(current.history, ctx.fixture.history);
  assertStage(ctx.fixture, current, ctx.fixture.arrivalEvidenceJourney.completedStep);
  await ctx.capture('00-resumed-exact-PDF-delivery-checkpoint', current);
  return finish({ ...ctx, resuming: true });
}

async function fillPdfClaim(ctx, form, index, kind, quote) {
  const proof = ctx.fixture.arrivalEvidenceJourney;
  await button(form, 'Add supplier statement').click();
  const editor = form.getByTestId('inventory-arrival-claim-editor');
  await ctx.choose(editor, 'Statement subject', `Component 1: ${proof.componentLabel}`);
  await ctx.choose(editor, 'Statement document', /^Document 1:/);
  await ctx.choose(
    editor,
    'Statement kind',
    {
      quantity: 'Quantity',
      'supplier-qc': 'Supplier quality result',
      'date-or-condition': 'Date or condition',
    }[kind]
  );
  await editor.getByLabel('PDF page', { exact: true }).fill('1');
  await field(editor, 'PDF region').fill(`Certificate statement ${index}`);
  await field(editor, 'Exact supplier quotation').fill(quote);
  if (kind === 'quantity') {
    await field(editor, 'Supplier quantity').fill('2');
    await field(editor, 'Supplier unit').fill('mg');
  } else if (kind === 'supplier-qc') {
    await field(editor, 'Supplier quality result').fill('pass');
  } else {
    await field(editor, 'Supplier date or condition').fill(quote);
  }
  await button(editor, 'Add statement').click();
  await ctx.expect(form.getByTestId('inventory-arrival-claim')).toHaveCount(index);
}

async function enterDelivery(ctx, current) {
  const { page, expect, choose, fixture } = ctx;
  const proof = fixture.arrivalEvidenceJourney;
  await closeStock(page);
  await button(page, 'Receive delivery').click();
  const form = modal(page);
  const earlier = fixture.arrivalComponentsJourney;
  if (earlier && !ctx.resuming) {
    await expect(field(form, 'Actual delivery ID')).toHaveValue(earlier.deliveryId);
    await expect(field(form, 'Original supplier document text')).toHaveValue(earlier.documentText);
    await expect(field(form, 'Component 2 label')).toHaveValue(earlier.unidentifiedLabel);
    const unchanged = await ctx.inventoryRead(fixture.scope);
    assert.deepEqual(unchanged.state, current.state);
    assert.deepEqual(unchanged.history, current.history);
    await ctx.capture('01-existing-text-draft-migrated-without-changing-original-source', {
      deliveryId: earlier.deliveryId,
      originalSourceText: earlier.documentText,
      ...unchanged,
    });
  }
  await button(form, 'Start a separate new delivery').click();
  await field(form, 'Delivery namespace').fill('desktop-arrival-evidence-acceptance');
  await field(form, 'Actual delivery ID').fill(proof.deliveryId);
  await field(form, 'Supplier').fill('Synthetic supplier');
  await field(form, 'Arrival observation reason').fill(
    'Actual synthetic PDF-backed reagent delivery observed'
  );
  await field(form, 'Component scope reason').fill(
    'One identified reagent vial explicitly observed'
  );
  const document = form.getByTestId('inventory-arrival-document').first();
  await choose(document, 'Document format', 'PDF original');
  await document.getByLabel('Original supplier document file', { exact: true }).setInputFiles({
    name: 'synthetic-original.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from(proof.pdfBase64, 'base64'),
  });
  await expect(document).toHaveAttribute('data-file-state', 'retained');
  await choose(document, 'Document coverage', 'Full original document');
  await form.locator('summary').filter({ hasText: 'Optional package grouping' }).click();
  await field(form, 'Package label').fill(proof.packageLabel);
  await field(form, 'Packaging batch').fill(proof.packagingBatch);
  await field(form, 'Find scientific material').fill(proof.material.id);
  await choose(form, 'Component 1 material', new RegExp(escaped(proof.material.name)));
  await field(form, 'Component 1 label').fill(proof.componentLabel);
  await field(form, 'Component 1 batch').fill(proof.componentBatch);
  await field(form, 'Component 1 new lot name').fill(proof.lotName);
  await field(form, 'Component 1 management reason').fill(
    'Independent local assessment; supplier QC is retained evidence only'
  );
  await field(form, 'Component 1 measured amount').fill('2');
  await choose(form, 'Component 1 unit', 'mg');
  await field(form, 'Component 1 amount reason').fill(
    'Exact supported supplier amount from the cited component quantity claim'
  );
  await choose(
    form,
    'Component 1 local stock quality',
    'Usable stock; lot assessment remains separate'
  );
  await field(form, 'Component 1 local quality reason').fill(
    'Explicit local stock observation independently of supplier QC'
  );
  await field(form, 'Component 1 container name').fill(proof.vesselName);
  await choose(form, 'Component 1 location', 'Unplaced');
  await fillPdfClaim(ctx, form, 1, 'quantity', proof.quantityQuote);
  await fillPdfClaim(ctx, form, 2, 'supplier-qc', proof.qcQuote);
  await fillPdfClaim(ctx, form, 3, 'date-or-condition', proof.dateQuote);
  await choose(form, 'Component 1 amount basis', 'Supplier-declared quantity');
  await choose(form, 'Component 1 supplier quantity statement', /^2 mg/);
  await button(form, 'Preview complete delivery').click();
  await expect(form.getByTestId('inventory-arrival-form')).toHaveAttribute(
    'data-preview-state',
    'ready'
  );
  await ctx.capture('02-ready-PDF-claims-and-independent-local-decisions', { before: current });
  await button(form, 'Receive delivery atomically').click();
  return form;
}

async function verifyPresentation(ctx, current, captureName) {
  const { page, expect, fixture } = ctx;
  const proof = fixture.arrivalEvidenceJourney;
  await closeStock(page);
  await button(page, 'Receive delivery').click();
  const form = modal(page);
  await expect(field(form, 'Actual delivery ID')).toHaveValue(proof.deliveryId);
  await button(form, 'Preview complete delivery').click();
  await expect(form.getByTestId('inventory-arrival-form')).toHaveAttribute(
    'data-preview-state',
    'no-change'
  );
  await expect(button(form, 'Receive delivery atomically')).toBeDisabled();
  const facts = form.getByTestId('inventory-arrival-facts').first();
  await expect(facts.locator('[data-original-received-quantity]')).toHaveText(
    'Original received amount: 2000000 ng'
  );
  await expect(facts.locator('[data-current-remaining-quantity]')).toHaveText(
    'Current remaining amount: 1900000 ng'
  );
  const arrival = arrivalOf(fixture, current.state);
  const retained = await page.evaluate(
    (input) => window.electronAPI.inventory.arrivalDocument(input),
    {
      ...fixture.scope,
      arrivalId: arrival.id,
      documentKey: arrival.documents[0].key,
      expectedSha256: proof.pdfSha256,
    }
  );
  assert.equal(retained.kind, 'available');
  assert.deepEqual(retained.body, { encoding: 'base64', value: proof.pdfBase64 });
  assert.equal(hash(Buffer.from(retained.body.value, 'base64')), proof.pdfSha256);
  await button(facts, `Read retained document ${arrival.documents[0].key}`).click();
  await expect(
    facts.getByRole('link', {
      name: `Download retained original ${arrival.documents[0].key}`,
      exact: true,
    })
  ).toBeVisible();
  await expect(facts).toContainText('application/pdf');
  await expect(facts).toContainText(proof.quantityQuote);
  await expect(facts).toContainText(proof.qcQuote);
  await expect(facts).toContainText(proof.dateQuote);
  const unchanged = await ctx.inventoryRead(fixture.scope);
  assert.deepEqual(unchanged.state, current.state);
  assert.deepEqual(unchanged.history, current.history);
  await ctx.capture(captureName, { ...unchanged, retained });
  await button(form, 'Cancel').click();
}

async function finish(ctx) {
  const { page, expect, choose, fixture, evidenceDirectory } = ctx;
  const proof = fixture.arrivalEvidenceJourney;
  let current = await ctx.inventoryRead(fixture.scope);
  writeFileSync(
    path.join(evidenceDirectory, 'synthetic-original.pdf'),
    Buffer.from(proof.pdfBase64, 'base64')
  );
  const checkpoint = (step) => {
    const saved = {
      ...fixture,
      ...current,
      arrivalEvidenceJourney: { ...proof, completedStep: step },
      resumePhase: 'arrival-evidence-after-accepted-stage',
    };
    writeFileSync(
      path.join(
        evidenceDirectory,
        `${String(step).padStart(2, '0')}-arrival-evidence-checkpoint.json`
      ),
      JSON.stringify(saved, null, 2)
    );
    return saved;
  };
  checkpoint(proof.completedStep);
  const actions = [
    () => enterDelivery(ctx, current),
    async () => {
      await closeStock(page);
      await button(page, 'Lot quality and recalls').click();
      const form = page.getByRole('dialog', { name: 'Lot quality and recalls', exact: true });
      await choose(form, 'Lot or preparation', new RegExp(`^${escaped(proof.lotName)}`));
      await button(form, 'Record assessment').click();
      await choose(form, 'Lot assessment', 'Released');
      await field(form, 'Reason').fill(
        'Explicit local release; original supplier QC did not release this lot'
      );
      await button(form, 'Record lot assessment').click();
      return form;
    },
    async () => {
      const arrival = arrivalOf(fixture, current.state);
      await showStock(page, arrival.components[0].target.stockId);
      await button(page, 'Use stock').click();
      const form = page.getByRole('dialog', { name: 'Use stock', exact: true });
      await field(form, 'Quantity').fill('100');
      await choose(form, 'Unit', 'µg');
      await field(form, 'Reason').fill('Consume only after independent local release');
      await button(form, 'Use stock').click();
      return form;
    },
  ];
  for (let index = proof.completedStep; index < actions.length; index++) {
    const form = await actions[index]();
    await expect
      .poll(async () => (await ctx.inventoryRead(fixture.scope)).state.revision)
      .toBe(proof.initialRevision + index + 1);
    current = await ctx.inventoryRead(fixture.scope);
    checkpoint(index + 1);
    await expect(form).toBeHidden();
    assertStage(fixture, current, index + 1);
    await showStock(page, arrivalOf(fixture, current.state).components[0].target.stockId);
    await ctx.capture(
      `${String(index + 3).padStart(2, '0')}-${['PDF-received-with-unassessed-lot', 'separate-local-release', 'used-stock-retains-original-PDF-and-receipt'][index]}`,
      current
    );
  }
  await verifyPresentation(ctx, current, '06-duplicate-keeps-current-stock-and-exact-retained-PDF');
  const result = checkpoint(3);
  writeFileSync(
    path.join(evidenceDirectory, 'arrival-evidence-reopen-fixture.json'),
    JSON.stringify(result, null, 2)
  );
  return result;
}

export async function runInventoryArrivalEvidenceReopen(ctx) {
  const current = await ctx.inventoryRead(ctx.fixture.scope);
  assert.deepEqual(current.state, ctx.fixture.state);
  assert.deepEqual(current.history, ctx.fixture.history);
  const textProof = ctx.fixture.arrivalEvidenceTextJourney;
  const corrections = ctx.fixture.stockroomCorrectionsJourney;
  if (corrections) {
    assert.equal(corrections.completedStep, 6);
    assert.equal(current.state.revision, corrections.initialRevision + 6);
    assert.ok(textProof);
    assert.equal(textProof.completedStep, 1);
    assertPdfFacts(ctx.fixture, current, 3);
    assertTextFacts(ctx.fixture, current);
  } else {
    assertStage(ctx.fixture, current, 3, textProof?.completedStep ?? 0);
  }
  writeFileSync(
    path.join(ctx.evidenceDirectory, 'synthetic-original.pdf'),
    Buffer.from(ctx.fixture.arrivalEvidenceJourney.pdfBase64, 'base64')
  );
  if (textProof) {
    if (!corrections) assertTextStage(ctx.fixture, current);
    await verifyTextPresentation(ctx, current, 'reopened-all-three-original-documents-and-claims');
  } else {
    await verifyPresentation(
      ctx,
      current,
      'reopened-exact-PDF-evidence-original-receipt-and-used-stock'
    );
  }
  return { ...ctx.fixture, ...current };
}

function textArrivalOf(fixture, state) {
  const arrival = Object.values(state.arrivals).find(
    (item) => item.identity.arrivalId === fixture.arrivalEvidenceTextJourney.deliveryId
  );
  assert.ok(arrival, 'The text and JSON delivery is recorded.');
  return arrival;
}

function assertTextStage(fixture, current) {
  const proof = fixture.arrivalEvidenceTextJourney;
  assert.equal(current.state.schema, 'dnaforge.inventory.v22');
  assert.equal(current.state.revision, proof.initialRevision + 1);
  assert.deepEqual(current.history.slice(0, proof.baselineHistory.length), proof.baselineHistory);
  for (const [id, stock] of Object.entries(proof.baselineStocks))
    assert.deepEqual(
      current.state.stocks[id],
      stock,
      'Text receiving preserves all earlier stock.'
    );
  assert.deepEqual(current.state.validityFacts, proof.baselineValidityFacts);
  assert.deepEqual(current.state.openingObservations, proof.baselineOpeningObservations);
  assertTextFacts(fixture, current);
}
function assertTextFacts(fixture, current) {
  const proof = fixture.arrivalEvidenceTextJourney;
  const arrival = textArrivalOf(fixture, current.state);
  assert.equal(arrival.documents.length, 2);
  const text = arrival.documents.find((document) => document.mediaType === 'text/plain');
  const json = arrival.documents.find((document) => document.mediaType === 'application/json');
  assert.ok(text);
  assert.ok(json);
  assert.equal(text.sha256, proof.textSha256);
  assert.equal(json.sha256, proof.jsonSha256);
  assert.deepEqual(text.coverage, { kind: 'full' });
  assert.deepEqual(json.coverage, { kind: 'full' });
  assert.equal(arrival.claims.length, 3);
  const textQuantity = arrival.claims.find(
    (claim) => claim.claim.kind === 'quantity' && claim.selection.documentKey === text.key
  );
  const jsonQuantity = arrival.claims.find(
    (claim) => claim.claim.kind === 'quantity' && claim.selection.documentKey === json.key
  );
  const identifier = arrival.claims.find((claim) => claim.claim.kind === 'identifier');
  assert.ok(textQuantity);
  assert.ok(jsonQuantity);
  assert.ok(identifier);
  assert.deepEqual(textQuantity.selection.locator, {
    kind: 'utf8-byte-range',
    startByte: proof.secondAmountStartByte,
    endByte: proof.secondAmountEndByte,
  });
  assert.equal(textQuantity.selection.verbatim, '1 mg');
  assert.deepEqual(textQuantity.claim, { kind: 'quantity', valueLexeme: '1', unitText: 'mg' });
  assert.deepEqual(jsonQuantity.selection.locator, { kind: 'json-pointer', pointer: '/amount' });
  assert.equal(jsonQuantity.selection.verbatim, '1.00');
  assert.deepEqual(jsonQuantity.claim, { kind: 'quantity', valueLexeme: '1.00', unitText: 'mg' });
  assert.deepEqual(identifier.selection.locator, { kind: 'json-pointer', pointer: '/batch' });
  assert.equal(identifier.selection.verbatim, proof.batch);
  assert.deepEqual(identifier.claim, {
    kind: 'identifier',
    role: 'component-batch',
    value: proof.batch,
  });
  const component = arrival.components[0];
  for (const claim of arrival.claims) {
    assert.equal(claim.verification, 'exact-text-selection');
    assert.deepEqual(claim.subject, { kind: 'component', componentKey: component.key });
  }
  assert.deepEqual(component.receivedQuantity, { kind: 'known', value: '1000000', unit: 'ng' });
  assert.deepEqual(component.choice.quantityBasis, {
    kind: 'supplier-declared',
    claimKey: textQuantity.key,
    reason: 'Exact supported amount from the deliberately selected second original occurrence',
  });
  assert.equal(component.componentBatch, proof.batch);
  assert.equal(current.state.lots[component.target.lotId].controls.assessment.value, 'unassessed');
  assert.deepEqual(
    current.state.stocks[component.target.stockId].quantity,
    component.receivedQuantity
  );
  const accepted = current.history[proof.initialRevision].request;
  assert.equal(accepted.kind, 'receive-arrival');
  const source = JSON.parse(accepted.sourceText);
  assert.deepEqual(source.documents.find((document) => document.key === text.key).body, {
    encoding: 'base64',
    value: Buffer.from(proof.text, 'utf8').toString('base64'),
  });
  assert.deepEqual(source.documents.find((document) => document.key === json.key).body, {
    encoding: 'base64',
    value: Buffer.from(proof.json, 'utf8').toString('base64'),
  });
}

export async function runInventoryArrivalEvidenceTextJourney(ctx) {
  const current = await ctx.inventoryRead(ctx.fixture.scope);
  assert.deepEqual(current.state, ctx.fixture.state);
  assert.deepEqual(current.history, ctx.fixture.history);
  assertStage(ctx.fixture, current, 3);
  const tag = randomUUID().slice(0, 8);
  const text =
    'β supplier certificate\r\nFirst listed amount: 1 mg\r\nSecond listed amount: 1 mg\r\n';
  const batch = `TEXT-${tag}`;
  const json = `{\r\n  "amount": 1.00,\r\n  "unit": "mg",\r\n  "batch": "${batch}"\r\n}\r\n`;
  const secondAmount = text.lastIndexOf('1 mg');
  assert.ok(secondAmount > text.indexOf('1 mg'));
  const proof = {
    initialRevision: current.state.revision,
    completedStep: 0,
    baselineStocks: current.state.stocks,
    baselineHistory: current.history,
    baselineValidityFacts: current.state.validityFacts,
    baselineOpeningObservations: current.state.openingObservations,
    deliveryId: `text-json-${tag}`,
    componentLabel: `Text ${tag} reagent`,
    vesselName: `Text ${tag} vial`,
    lotName: `Text ${tag} supplier lot`,
    batch,
    text,
    json,
    textSha256: hash(Buffer.from(text, 'utf8')),
    jsonSha256: hash(Buffer.from(json, 'utf8')),
    secondAmountStartByte: Buffer.byteLength(text.slice(0, secondAmount), 'utf8'),
    secondAmountEndByte: Buffer.byteLength(text.slice(0, secondAmount + 4), 'utf8'),
    material: ctx.fixture.arrivalEvidenceJourney.material,
  };
  return finishText({ ...ctx, fixture: { ...ctx.fixture, arrivalEvidenceTextJourney: proof } });
}

export async function runInventoryArrivalEvidenceTextResume(ctx) {
  assert.equal(ctx.fixture.resumePhase, 'arrival-evidence-text-after-accepted-stage');
  const current = await ctx.inventoryRead(ctx.fixture.scope);
  assert.deepEqual(current.state, ctx.fixture.state);
  assert.deepEqual(current.history, ctx.fixture.history);
  const completed = ctx.fixture.arrivalEvidenceTextJourney.completedStep;
  assert.ok(completed === 0 || completed === 1);
  if (completed) assertTextStage(ctx.fixture, current);
  else assertStage(ctx.fixture, current, 3);
  await ctx.capture('00-resumed-exact-text-and-JSON-checkpoint', current);
  return finishText(ctx);
}

async function addTextClaim(ctx, form) {
  const proof = ctx.fixture.arrivalEvidenceTextJourney;
  await button(form, 'Add supplier statement').click();
  const editor = form.getByTestId('inventory-arrival-claim-editor');
  await ctx.choose(editor, 'Statement subject', `Component 1: ${proof.componentLabel}`);
  await ctx.choose(editor, 'Statement document', /^Document 1:/);
  await ctx.choose(editor, 'Statement kind', 'Quantity');
  const source = field(editor, 'Select exact original text');
  const displayed = await source.inputValue();
  assert.equal(displayed, proof.text.replace(/\r\n?/gu, '\n'));
  const start = displayed.lastIndexOf('1 mg');
  assert.ok(start > displayed.indexOf('1 mg'));
  await source.focus();
  await source.evaluate(
    (node, selection) => {
      node.setSelectionRange(selection.start, selection.end);
      node.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
      document.dispatchEvent(new Event('selectionchange', { bubbles: true }));
    },
    { start, end: start + 4 }
  );
  await ctx.expect(field(editor, 'Exact supplier quotation')).toHaveValue('1 mg');
  await field(editor, 'Supplier quantity').fill('1');
  await field(editor, 'Supplier unit').fill('mg');
  await ctx.capture('02-second-original-amount-selected-after-multibyte-and-CRLF', {
    normalizedDomStart: start,
    expectedOriginalByteStart: proof.secondAmountStartByte,
    expectedOriginalByteEnd: proof.secondAmountEndByte,
  });
  await button(editor, 'Add statement').click();
  await ctx.expect(form.getByTestId('inventory-arrival-claim')).toHaveCount(1);
}

async function addJsonClaim(ctx, form, kind) {
  const proof = ctx.fixture.arrivalEvidenceTextJourney;
  await button(form, 'Add supplier statement').click();
  const editor = form.getByTestId('inventory-arrival-claim-editor');
  await ctx.choose(editor, 'Statement subject', `Component 1: ${proof.componentLabel}`);
  await ctx.choose(editor, 'Statement document', /^Document 2:/);
  await ctx.choose(editor, 'Statement kind', kind === 'quantity' ? 'Quantity' : 'Identifier');
  await ctx.choose(editor, 'Text location', 'Specify a JSON pointer');
  await field(editor, 'JSON pointer').fill(kind === 'quantity' ? '/amount' : '/batch');
  await field(editor, 'Exact supplier quotation').fill(kind === 'quantity' ? '1.00' : proof.batch);
  if (kind === 'quantity') {
    await field(editor, 'Supplier quantity').fill('1.00');
    await field(editor, 'Supplier unit').fill('mg');
  } else {
    await ctx.choose(editor, 'Identifier describes', 'Component batch');
    await field(editor, 'Supplier identifier').fill(proof.batch);
  }
  await button(editor, 'Add statement').click();
  await ctx
    .expect(form.getByTestId('inventory-arrival-claim'))
    .toHaveCount(kind === 'quantity' ? 2 : 3);
}

async function enterTextDelivery(ctx, current) {
  const { page, expect, choose, fixture } = ctx;
  const proof = fixture.arrivalEvidenceTextJourney;
  await closeStock(page);
  await button(page, 'Receive delivery').click();
  const form = modal(page);
  await button(form, 'Start a separate new delivery').click();
  await field(form, 'Delivery namespace').fill('desktop-arrival-evidence-acceptance');
  await field(form, 'Actual delivery ID').fill(proof.deliveryId);
  await field(form, 'Supplier').fill('Synthetic supplier');
  await field(form, 'Arrival observation reason').fill(
    'Actual synthetic text and JSON delivery observed'
  );
  await field(form, 'Component scope reason').fill(
    'One identified reagent vial listed in the two retained documents'
  );
  const document = form.getByTestId('inventory-arrival-document').first();
  await document.getByLabel('Original supplier document file', { exact: true }).setInputFiles({
    name: 'synthetic-original-crlf.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from(proof.text, 'utf8'),
  });
  await expect(document).toHaveAttribute('data-file-state', 'retained');
  await choose(document, 'Document coverage', 'Full original text document');
  await button(form, 'Add another document').click();
  const jsonDocument = form.getByTestId('inventory-arrival-document').nth(1);
  await choose(jsonDocument, 'Document 2 document format', 'JSON text');
  await jsonDocument
    .getByLabel('Document 2 original supplier document file', { exact: true })
    .setInputFiles({
      name: 'synthetic-original.json',
      mimeType: 'application/json',
      buffer: Buffer.from(proof.json, 'utf8'),
    });
  await expect(jsonDocument).toHaveAttribute('data-file-state', 'retained');
  await choose(jsonDocument, 'Document 2 document coverage', 'Full original text document');
  await field(form, 'Find scientific material').fill(proof.material.id);
  await choose(form, 'Component 1 material', new RegExp(escaped(proof.material.name)));
  await field(form, 'Component 1 label').fill(proof.componentLabel);
  await field(form, 'Component 1 batch').fill(proof.batch);
  await field(form, 'Component 1 new lot name').fill(proof.lotName);
  await field(form, 'Component 1 management reason').fill(
    'Local lot assessment remains independent of supplier statements'
  );
  await field(form, 'Component 1 measured amount').fill('1');
  await choose(form, 'Component 1 unit', 'mg');
  await field(form, 'Component 1 amount reason').fill(
    'Exact supported amount from the deliberately selected second original occurrence'
  );
  await choose(
    form,
    'Component 1 local stock quality',
    'Usable stock; lot assessment remains separate'
  );
  await field(form, 'Component 1 local quality reason').fill(
    'Explicit local quality observation; no supplier statement releases the lot'
  );
  await field(form, 'Component 1 container name').fill(proof.vesselName);
  await choose(form, 'Component 1 location', 'Unplaced');
  await addTextClaim(ctx, form);
  await addJsonClaim(ctx, form, 'quantity');
  await addJsonClaim(ctx, form, 'identifier');
  await choose(form, 'Component 1 amount basis', 'Supplier-declared quantity');
  await choose(form, 'Component 1 supplier quantity statement', /^1 mg/);
  await button(form, 'Preview complete delivery').click();
  await expect(form.getByTestId('inventory-arrival-form')).toHaveAttribute(
    'data-preview-state',
    'ready'
  );
  await ctx.capture('03-ready-exact-text-JSON-lexeme-and-component-identifier', {
    before: current,
  });
  await button(form, 'Receive delivery atomically').click();
  return form;
}

async function originalDocument(ctx, arrival, document, bytes) {
  const retained = await ctx.page.evaluate(
    (input) => window.electronAPI.inventory.arrivalDocument(input),
    {
      ...ctx.fixture.scope,
      arrivalId: arrival.id,
      documentKey: document.key,
      expectedSha256: document.sha256,
    }
  );
  assert.equal(retained.kind, 'available');
  assert.equal(retained.body.encoding, 'base64');
  assert.equal(retained.body.value, bytes.toString('base64'));
  assert.equal(hash(Buffer.from(retained.body.value, 'base64')), document.sha256);
  return retained;
}

async function verifyTextPresentation(ctx, current, captureName) {
  const { page, expect, fixture } = ctx;
  const proof = fixture.arrivalEvidenceTextJourney;
  const arrival = textArrivalOf(fixture, current.state);
  await closeStock(page);
  await button(page, 'Receive delivery').click();
  const form = modal(page);
  await expect(field(form, 'Actual delivery ID')).toHaveValue(proof.deliveryId);
  await button(form, 'Preview complete delivery').click();
  await expect(form.getByTestId('inventory-arrival-form')).toHaveAttribute(
    'data-preview-state',
    'no-change'
  );
  await expect(button(form, 'Receive delivery atomically')).toBeDisabled();
  const facts = form.getByTestId('inventory-arrival-facts').first();
  await expect(facts.locator('[data-original-received-quantity]')).toHaveText(
    'Original received amount: 1000000 ng'
  );
  await expect(facts.locator('[data-current-remaining-quantity]')).toHaveText(
    'Current remaining amount: 1000000 ng'
  );
  await expect(facts.locator('[data-verification="exact-text-selection"]')).toHaveCount(3);
  await expect(facts).toContainText('1.00');
  await expect(facts).toContainText(proof.batch);
  const retained = [];
  for (const document of arrival.documents) {
    retained.push(
      await originalDocument(
        ctx,
        arrival,
        document,
        Buffer.from(document.mediaType === 'text/plain' ? proof.text : proof.json, 'utf8')
      )
    );
    await button(facts, `Read retained document ${document.key}`).click();
    await expect(
      facts.getByRole('link', { name: `Download retained original ${document.key}`, exact: true })
    ).toBeVisible();
  }
  const previous = arrivalOf(fixture, current.state);
  const summary = form
    .locator('summary')
    .filter({ hasText: /^Previously received deliveries/ })
    .first();
  if ((await summary.locator('..').getAttribute('open')) === null) await summary.click();
  const pdfFacts = form
    .locator(`[data-testid="inventory-arrival-facts"][data-arrival-id="${previous.id}"]`)
    .last();
  const parent = pdfFacts.locator('..');
  if ((await parent.getAttribute('open')) === null)
    await parent.locator(':scope > summary').click();
  await pdfFacts.scrollIntoViewIfNeeded();
  await expect(pdfFacts.locator('[data-original-received-quantity]')).toHaveText(
    'Original received amount: 2000000 ng'
  );
  await expect(pdfFacts.locator('[data-current-remaining-quantity]')).toHaveText(
    'Current remaining amount: 1900000 ng'
  );
  retained.push(
    await originalDocument(
      ctx,
      previous,
      previous.documents[0],
      Buffer.from(fixture.arrivalEvidenceJourney.pdfBase64, 'base64')
    )
  );
  await button(pdfFacts, `Read retained document ${previous.documents[0].key}`).click();
  await expect(
    pdfFacts.getByRole('link', {
      name: `Download retained original ${previous.documents[0].key}`,
      exact: true,
    })
  ).toBeVisible();
  await expect(pdfFacts.locator('[data-verification="operator-cited-pdf-region"]')).toHaveCount(3);
  const unchanged = await ctx.inventoryRead(fixture.scope);
  assert.deepEqual(unchanged.state, current.state);
  assert.deepEqual(unchanged.history, current.history);
  await ctx.capture(captureName, { ...unchanged, retained });
  await button(form, 'Cancel').click();
}

async function finishText(ctx) {
  const { fixture, evidenceDirectory, expect } = ctx;
  const proof = fixture.arrivalEvidenceTextJourney;
  let current = await ctx.inventoryRead(fixture.scope);
  writeFileSync(
    path.join(evidenceDirectory, 'synthetic-original-crlf.txt'),
    Buffer.from(proof.text, 'utf8')
  );
  writeFileSync(
    path.join(evidenceDirectory, 'synthetic-original.json'),
    Buffer.from(proof.json, 'utf8')
  );
  const checkpoint = (step) => {
    const saved = {
      ...fixture,
      ...current,
      arrivalEvidenceTextJourney: { ...proof, completedStep: step },
      resumePhase: 'arrival-evidence-text-after-accepted-stage',
    };
    writeFileSync(
      path.join(
        evidenceDirectory,
        `${String(step).padStart(2, '0')}-arrival-evidence-text-checkpoint.json`
      ),
      JSON.stringify(saved, null, 2)
    );
    return saved;
  };
  checkpoint(proof.completedStep);
  if (!proof.completedStep) {
    const form = await enterTextDelivery(ctx, current);
    await expect
      .poll(async () => (await ctx.inventoryRead(fixture.scope)).state.revision)
      .toBe(proof.initialRevision + 1);
    current = await ctx.inventoryRead(fixture.scope);
    checkpoint(1);
    await expect(form).toBeHidden();
  }
  assertTextStage(fixture, current);
  assertStage(fixture, current, 3, 1);
  await ctx.capture('04-text-and-JSON-received-once-with-unassessed-lot', current);
  await verifyTextPresentation(
    ctx,
    current,
    '05-all-three-original-documents-and-independent-current-stock'
  );
  const result = checkpoint(1);
  writeFileSync(
    path.join(evidenceDirectory, 'arrival-evidence-reopen-fixture.json'),
    JSON.stringify(result, null, 2)
  );
  return result;
}
