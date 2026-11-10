import { expect, it } from 'vitest';
import { PrismaSqlite } from '../../src/storage/prisma-sqlite/index.js';

it('releases transaction admission after BEGIN fails without rolling back another owner', async () => {
  const adapter = await new PrismaSqlite({ url: ':memory:' }).connect();
  try {
    await adapter.executeScript("CREATE TABLE retained(value TEXT); BEGIN; INSERT INTO retained VALUES('synthetic')");
    await expect(adapter.startTransaction()).rejects.toThrow('transaction');
    const during = await adapter.queryRaw({ sql: 'SELECT count(*) FROM retained', args: [], argTypes: [] });
    expect(during.rows).toEqual([[1]]);
    await adapter.executeScript('ROLLBACK');
    const transaction = await adapter.startTransaction();
    await adapter.executeScript('ROLLBACK');
    await transaction.rollback();
    const after = await adapter.queryRaw({ sql: 'SELECT count(*) FROM retained', args: [], argTypes: [] });
    expect(after.rows).toEqual([[0]]);
  } finally { await adapter.dispose(); }
});
