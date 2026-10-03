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

if command -v docker-compose >/dev/null 2>&1; then DC="docker-compose"; else DC="docker compose"; fi

$DC exec -T postgres psql -U hackathon -v ON_ERROR_STOP=1 << 'SQL'
BEGIN;
-- Delete in dependency order (checked against every foreign key)
DELETE FROM decision_reports;
DELETE FROM team_decisions;
DELETE FROM judge_links;
DELETE FROM judging_days;
DELETE FROM criterion_scores;
DELETE FROM scorecards;
DELETE FROM session_judges;
DELETE FROM ranking_results;
DELETE FROM judging_sessions;
DELETE FROM judge_messages;
DELETE FROM conflict_declarations;
DELETE FROM judge_availability;
DELETE FROM judge_expertise;
DELETE FROM judges;
DELETE FROM team_members;
DELETE FROM teams;
DELETE FROM scoring_criteria;
DELETE FROM scoring_templates;
DELETE FROM time_slots;
DELETE FROM room_unavailability;
DELETE FROM rooms;
DELETE FROM judging_rounds;
DELETE FROM challenge_tracks;
DELETE FROM event_users;
DELETE FROM audit_logs;
DELETE FROM events;
COMMIT;

-- Verify
SELECT 'Events: ' || COUNT(*) FROM events
UNION ALL SELECT 'Teams: ' || COUNT(*) FROM teams
UNION ALL SELECT 'Judges: ' || COUNT(*) FROM judges
UNION ALL SELECT 'Sessions: ' || COUNT(*) FROM judging_sessions
UNION ALL SELECT 'Scorecards: ' || COUNT(*) FROM scorecards
UNION ALL SELECT 'Users kept: ' || COUNT(*) FROM users;
SQL

echo ""
echo "✅ Data cleared. Users preserved."
