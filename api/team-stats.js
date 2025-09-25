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
  const allMatches = new Map(); // Все уникальные матчи
  const teamPlayerNames = new Set(players.map(p => p.nickname));

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

        // Сохраняем матч если его еще нет в коллекции
        if (!allMatches.has(match.match_id)) {
          allMatches.set(match.match_id, {
            id: match.match_id,
            date: new Date(match.finished_at * 1000).toISOString(),
            finished_at: match.finished_at,
            teams: match.teams,
            results: match.results,
            voting: match.voting
          });
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

  console.log(`Total matches found: ${allMatches.size}`);

  // 4. Фильтруем матчи где играла команда (минимум 5 игроков из нашей команды)
  const teamMatches = [];
  
  for (const match of allMatches.values()) {
    const playersInMatch = getPlayersFromMatch(match);
    const ourPlayersInMatch = playersInMatch.filter(player => 
      teamPlayerNames.has(player.nickname)
    );
    
    // Если в матче 5 или более игроков из нашей команды - это командный матч
    if (ourPlayersInMatch.length >= 5) {
      // Получаем детали матча для точного определения карты
      const matchDetails = await getMatchDetails(match.id, apiKey);
      
      teamMatches.push({
        id: match.id,
        date: match.date,
        map: getMapName(matchDetails || match),
        result: getMatchResult(match, ourPlayersInMatch),
        score: match.results?.score || {},
        ourPlayers: ourPlayersInMatch.map(p => p.nickname),
        totalOurPlayers: ourPlayersInMatch.length
      });
    }
  }

  console.log(`Team matches (with 5+ players): ${teamMatches.length}`);

  // 5. Анализируем статистику по картам
  const mapStats = analyzeMapStatistics(teamMatches);

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
    totalMatches: teamMatches.length,
    mapStatistics: mapStats,
    recentMatches: teamMatches
      .sort((a, b) => new Date(b.date) - new Date(a.date))
      .slice(0, 10),
    debug: {
      allMatchesFound: allMatches.size,
      teamMatchesFound: teamMatches.length
    }
  };
}

function getPlayersFromMatch(match) {
  const players = [];
  
  if (match.teams) {
    for (const team of Object.values(match.teams)) {
      for (const player of team.players || []) {
        players.push({
          nickname: player.nickname,
          team: team.team_id
        });
      }
    }
  }
  
  return players;
}

async function getMatchDetails(matchId, apiKey) {
  try {
    const response = await fetch(`https://open.faceit.com/data/v4/matches/${matchId}`, {
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      }
    });

    if (response.ok) {
      return await response.json();
    }
  } catch (error) {
    console.warn(`Could not fetch details for match ${matchId}`);
  }
  return null;
}

function getMapName(matchData) {
  // Пробуем разные способы получить название карты
  if (matchData.voting?.map?.pick?.[0]) {
    return matchData.voting.map.pick[0];
  }
  if (matchData.voting?.map?.entities?.[0]?.name) {
    return matchData.voting.map.entities[0].name;
  }
  if (matchData.voting?.map?.entities?.[0]?.guid) {
    // Пробуем извлечь название из GUID
    const guid = matchData.voting.map.entities[0].guid;
    if (guid.includes('de_')) {
      return guid.split('_').slice(0, 2).join('_');
    }
    return guid;
  }
  return 'Unknown';
}

function getMatchResult(match, ourPlayers) {
  if (!match.results?.winner) return 'Unknown';
  
  const winnerTeam = match.results.winner;
  
  // Проверяем есть ли наши игроки в победившей команде
  const winningTeamPlayers = getPlayersFromMatch(match).filter(p => p.team === winnerTeam);
  const ourWinningPlayers = winningTeamPlayers.filter(p => 
    ourPlayers.some(op => op.nickname === p.nickname)
  );
  
  return ourWinningPlayers.length > 0 ? 'Win' : 'Loss';
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

    if (match.result === 'Win') {
      stats.wins++;
    } else {
      stats.losses++;
    }

    stats.winRate = stats.totalMatches > 0 ? 
      Math.round((stats.wins / stats.totalMatches) * 100) : 0;
  });

  return Object.values(mapStats)
    .sort((a, b) => b.totalMatches - a.totalMatches)
    .filter(map => map.map !== 'Unknown');
}