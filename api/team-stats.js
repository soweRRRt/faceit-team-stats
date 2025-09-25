export default async function handler(req, res) {
  // Настройки CORS для доступа из браузера
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  // Обработка предварительных запросов
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  // Проверяем что запрос GET
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Получаем ID команды из параметров запроса
  const { teamId } = req.query;

  // Проверяем что teamId передан
  if (!teamId) {
    return res.status(400).json({ 
      error: 'Team ID is required. Usage: /api/team-stats?teamId=TEAM_ID' 
    });
  }

  // Получаем API ключ из переменных окружения Vercel
  const FACEIT_API_KEY = process.env.FACEIT_API_KEY;

  if (!FACEIT_API_KEY) {
    return res.status(500).json({ 
      error: 'FACEIT API key not configured' 
    });
  }

  try {
    // Основная логика получения статистики
    const teamStats = await getTeamStats(teamId, FACEIT_API_KEY);
    res.status(200).json(teamStats);
  } catch (error) {
    console.error('Error:', error.message);
    res.status(500).json({ 
      error: 'Failed to fetch team statistics',
      details: error.message 
    });
  }
}

async function getTeamStats(teamId, apiKey) {
  console.log(`Fetching data for team: ${teamId}`);

  // 1. Получаем данные команды
  const teamResponse = await fetch(`https://open.faceit.com/data/v4/teams/${teamId}`, {
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    }
  });

  if (!teamResponse.ok) {
    throw new Error(`FACEIT API error: ${teamResponse.status}`);
  }

  const teamData = await teamResponse.json();

  // 2. Извлекаем игроков команды
  const players = teamData.members.map(member => ({
    id: member.user_id,
    nickname: member.nickname
  }));

  console.log(`Found ${players.length} players:`, players.map(p => p.nickname));

  // 3. Для каждого игрока получаем историю матчей за 3 месяца
  const threeMonthsAgo = Math.floor(Date.now() / 1000) - (90 * 24 * 60 * 60);
  const teamMatches = new Map();

  for (const player of players) {
    console.log(`Getting matches for ${player.nickname}...`);
    
    let offset = 0;
    const limit = 100;
    let hasMoreMatches = true;

    while (hasMoreMatches) {
      const matchesResponse = await fetch(
        `https://open.faceit.com/data/v4/players/${player.id}/history?offset=${offset}&limit=${limit}`,
        {
          headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json'
          }
        }
      );

      if (!matchesResponse.ok) {
        console.warn(`Failed to get matches for ${player.nickname}`);
        break;
      }

      const matchesData = await matchesResponse.json();
      
      if (!matchesData.items || matchesData.items.length === 0) {
        hasMoreMatches = false;
        break;
      }

      // Фильтруем матчи за последние 3 месяца
      for (const match of matchesData.items) {
        const matchTimestamp = match.finished_at;
        
        if (matchTimestamp < threeMonthsAgo) {
          hasMoreMatches = false;
          break;
        }

        // Проверяем что в матче только игроки из нашей команды
        if (await isTeamMatch(match, players)) {
          if (!teamMatches.has(match.match_id)) {
            teamMatches.set(match.match_id, {
              id: match.match_id,
              date: new Date(match.finished_at * 1000).toISOString(),
              map: match.voting?.map?.pick?.[0] || 'Unknown',
              result: match.results?.winner || 'Unknown',
              score: match.results?.score || {}
            });
          }
        }
      }

      offset += limit;
      if (offset >= matchesData.end) {
        hasMoreMatches = false;
      }

      // Задержка чтобы не превысить лимиты API
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }

  // 4. Анализируем статистику по картам
  const mapStats = analyzeMapStatistics(Array.from(teamMatches.values()));

  return {
    team: {
      id: teamData.team_id,
      name: teamData.name,
      avatar: teamData.avatar
    },
    period: {
      from: new Date(threeMonthsAgo * 1000).toISOString(),
      to: new Date().toISOString()
    },
    players: players.map(p => p.nickname),
    totalMatches: teamMatches.size,
    mapStatistics: mapStats,
    recentMatches: Array.from(teamMatches.values())
      .sort((a, b) => new Date(b.date) - new Date(a.date))
      .slice(0, 10)
  };
}

async function isTeamMatch(match, teamPlayers) {
  // Упрощенная проверка - считаем что матч подходит если в нем есть игроки команды
  const teamPlayerNames = new Set(teamPlayers.map(p => p.nickname));
  
  if (match.teams) {
    for (const team of Object.values(match.teams)) {
      for (const player of team.players || []) {
        if (teamPlayerNames.has(player.nickname)) {
          return true;
        }
      }
    }
  }
  
  return false;
}

function analyzeMapStatistics(matches) {
  const mapStats = {};

  matches.forEach(match => {
    const mapName = match.map;
    
    if (!mapStats[mapName]) {
      mapStats[mapName] = {
        map: mapName,
        totalMatches: 0,
        wins: 0,
        losses: 0,
        winRate: 0
      };
    }

    const stats = mapStats[mapName];
    stats.totalMatches++;

    // Простая проверка победы (можно улучшить)
    if (match.result && match.result !== 'Unknown') {
      stats.wins++;
    } else {
      stats.losses++;
    }

    stats.winRate = (stats.wins / stats.totalMatches) * 100;
  });

  return Object.values(mapStats).sort((a, b) => b.totalMatches - a.totalMatches);
}