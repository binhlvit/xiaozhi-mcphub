import { beforeEach, describe, expect, it } from '@jest/globals';
import { GroupDaoImpl } from '../../src/dao/GroupDao.js';
import { createMemoryJsonDao } from '../utils/testHelpers.js';

describe('GroupDao.findByName cross-owner ambiguity (fail closed)', () => {
  let dao: GroupDaoImpl;

  beforeEach(() => {
    ({ dao } = createMemoryJsonDao(new GroupDaoImpl(), { groups: [] }));
  });

  it('returns the group when the name is unique', async () => {
    await dao.create({ name: 'ops', owner: 'admin', servers: [] } as any);

    const found = await dao.findByName('ops');
    expect(found).not.toBeNull();
    expect(found?.owner).toBe('admin');
  });

  it('returns null instead of an arbitrary match when two owners share a group name', async () => {
    await dao.create({ name: 'ops', owner: 'admin', servers: [] } as any);
    await dao.create({ name: 'ops', owner: 'attacker', servers: [] } as any);

    // A bare name lookup can no longer disambiguate which owner's group is
    // meant, so it must deny (null) rather than silently pick one — this is
    // what bearer-key group-scope authorization relies on.
    expect(await dao.findByName('ops')).toBeNull();

    // Owner-scoped lookup remains unambiguous and still works.
    expect((await dao.findByOwnerAndName('admin', 'ops'))?.owner).toBe('admin');
    expect((await dao.findByOwnerAndName('attacker', 'ops'))?.owner).toBe('attacker');
  });

  it('returns null when no group has that name', async () => {
    expect(await dao.findByName('does-not-exist')).toBeNull();
  });
});
