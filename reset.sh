#!/bin/bash
echo "⚠️  This will delete ALL event data (teams, judges, sessions, scores, rankings)."
echo "   Admin and coordinator accounts will be preserved."
echo ""
read -p "Type 'RESET' to confirm: " confirm

if [ "$confirm" != "RESET" ]; then
  echo "Cancelled."
  exit 0
fi

echo "Resetting database..."

docker-compose exec -T postgres psql -U hackathon << 'SQL'
-- Delete in dependency order
DELETE FROM criterion_scores;
DELETE FROM scorecards;
DELETE FROM session_judges;
DELETE FROM judging_sessions;
DELETE FROM ranking_results;
DELETE FROM conflict_declarations;
DELETE FROM judge_availability;
DELETE FROM judge_expertise;
DELETE FROM judges;
DELETE FROM teams;
DELETE FROM scoring_criteria;
DELETE FROM scoring_templates;
DELETE FROM time_slots;
DELETE FROM rooms;
DELETE FROM challenge_tracks;
DELETE FROM audit_logs;
DELETE FROM events;

-- Verify
SELECT 'Events: ' || COUNT(*) FROM events
UNION ALL SELECT 'Teams: ' || COUNT(*) FROM teams
UNION ALL SELECT 'Judges: ' || COUNT(*) FROM judges
UNION ALL SELECT 'Sessions: ' || COUNT(*) FROM judging_sessions
UNION ALL SELECT 'Scorecards: ' || COUNT(*) FROM scorecards
UNION ALL SELECT 'Users kept: ' || COUNT(*) FROM users;
SQL

echo ""
echo "✅ Data cleared. Users preserved. Ready for fresh setup at https://judge.uobigedm.com/login"
