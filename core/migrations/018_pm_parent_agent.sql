-- 018_pm_parent_agent.sql
-- Promote parent_agent_id from plan_json workaround to first-class column.
ALTER TABLE pm_agents ADD COLUMN parent_agent_id INTEGER REFERENCES pm_agents(id) ON DELETE SET NULL;
CREATE INDEX idx_pm_agents_parent ON pm_agents(parent_agent_id);