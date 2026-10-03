import re

with open('/Users/akilanlingam/hackathon-platform/apps/api/src/operations/operations.service.ts', 'r') as f:
    content = f.read()

old = """    // Swap only the team assignments - judges stay in their rooms
    await this.prisma.$transaction(async (tx) => {
      // Swap team IDs
      await tx.judgingSession.update({ where: { id: a.id }, data: { teamId: b.teamId } });
      await tx.judgingSession.update({ where: { id: b.id }, data: { teamId: a.teamId } });"""

new = """    // Swap only the team assignments - judges stay in their rooms
    // Use raw SQL to atomically swap team IDs (avoids unique constraint on team_id + time_slot_id)
    await this.prisma.$executeRawUnsafe(
      `UPDATE judging_sessions SET team_id = CASE id::text WHEN $1 THEN $3::uuid WHEN $2 THEN $4::uuid END WHERE id::text IN ($1, $2)`,
      a.id, b.id, b.teamId, a.teamId,
    );

    await this.prisma.$transaction(async (tx) => {"""

if old in content:
    content = content.replace(old, new)
    with open('/Users/akilanlingam/hackathon-platform/apps/api/src/operations/operations.service.ts', 'w') as f:
        f.write(content)
    print('Fixed swapTeams with raw SQL')
else:
    print('Pattern not found - checking...')
    if 'Swap team IDs' in content:
        print('Found "Swap team IDs" but surrounding code differs')
    else:
        print('swapTeams section not found')
