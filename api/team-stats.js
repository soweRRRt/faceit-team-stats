export default async function handler(req, res) {
  // Настройки CORS для доступа из браузера
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { teamId } = req.query;

  if (!teamId) {
    return res.status(400).json({ 
      error: 'Team ID is required. Usage: /api/team-stats?teamId=TEAM_ID' 
    });
  }

  const FACEIT_API_KEY = process.env.FACEIT_API_KEY;

  if (!FACEIT_API_KEY) {
    return res.status(500).json({ 
      error: 'FACEIT API key not configured' 
    });
  }

  try {
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
  const allMatches = new Map();
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

      for (const match of matchesData.items) {
        const matchTimestamp = match.finished_at;
        
        if (matchTimestamp < threeMonthsAgo) {
          hasMoreMatches = false;
          break;
        }

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

      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }

  console.log(`Total matches found: ${allMatches.size}`);

  // 4. Группируем матчи по боям (сериям)
  const seriesMatches = await groupMatchesIntoSeries(Array.from(allMatches.values()), apiKey);
  console.log(`Series found: ${seriesMatches.length}`);

  // 5. Фильтруем серии где играла команда (минимум 5 игроков из нашей команды)
  const teamSeries = [];
  
  for (const series of seriesMatches) {
    const ourPlayersInSeries = getOurPlayersInSeries(series, teamPlayerNames);
    
    // Если в серии 5 или более игроков из нашей команды - это командная серия
    if (ourPlayersInSeries.length >= 5) {
      teamSeries.push({
        ...series,
        ourPlayers: ourPlayersInSeries,
        totalOurPlayers: ourPlayersInSeries.length
      });
    }
  }

  console.log(`Team series (with 5+ players): ${teamSeries.length}`);

  // 6. Анализируем статистику по картам из КОМАНДНЫХ серий
  const mapStats = analyzeMapStatisticsFromSeries(teamSeries);

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
    totalSeries: teamSeries.length,
    totalMatches: teamSeries.reduce((total, series) => total + series.matches.length, 0),
    mapStatistics: mapStats,
    recentSeries: teamSeries
      .sort((a, b) => new Date(b.date) - new Date(a.date))
      .slice(0, 10)
      .map(series => ({
        id: series.id,
        date: series.date,
        maps: series.matches.map(match => ({
          map: match.map,
          result: match.result,
          score: match.score
        })),
        seriesResult: getSeriesResult(series),
        ourPlayers: series.ourPlayers,
        totalOurPlayers: series.totalOurPlayers
      })),
    debug: {
      allMatchesFound: allMatches.size,
      seriesFound: seriesMatches.length,
      teamSeriesFound: teamSeries.length
    }
  };
}

async function groupMatchesIntoSeries(matches, apiKey) {
  const seriesMap = new Map();
  
  // Сначала собираем все ID матчей которые нужно проверить
  const matchIdsToCheck = new Set(matches.map(m => m.id));
  
  for (const match of matches) {
    // Если матч уже обработан в какой-то серии - пропускаем
    if ([...seriesMap.values()].some(series => 
      series.matches.some(m => m.id === match.id)
    )) {
      continue;
    }
    
    try {
      // Получаем детали матча чтобы найти серию
      const matchDetails = await getMatchDetails(match.id, apiKey);
      
      if (matchDetails && matchDetails.parent_match_id) {
        // Это матч из серии - находим все матчи серии
        const seriesId = matchDetails.parent_match_id;
        
        if (!seriesMap.has(seriesId)) {
          // Находим все матчи этой серии
          const seriesMatches = await findSeriesMatches(seriesId, matchIdsToCheck, apiKey);
          
          if (seriesMatches.length > 0) {
            seriesMap.set(seriesId, {
              id: seriesId,
              date: seriesMatches[0].date,
              matches: seriesMatches
            });
          }
        }
      } else {
        // Одиночный матч (не серия)
        seriesMap.set(match.id, {
          id: match.id,
          date: match.date,
          matches: [{
            id: match.id,
            date: match.date,
            map: getMapName(match),
            result: getMatchResult(match),
            score: match.results?.score || {}
          }]
        });
      }
    } catch (error) {
      console.warn(`Error processing match ${match.id}:`, error.message);
      // Если ошибка - считаем одиночным матчем
      seriesMap.set(match.id, {
        id: match.id,
        date: match.date,
        matches: [{
          id: match.id,
          date: match.date,
          map: getMapName(match),
          result: getMatchResult(match),
          score: match.results?.score || {}
        }]
      });
    }
    
    await new Promise(resolve => setTimeout(resolve, 50)); // Задержка между запросами
  }
  
  return Array.from(seriesMap.values());
}

async function findSeriesMatches(seriesId, availableMatchIds, apiKey) {
  const seriesMatches = [];
  
  try {
    // Получаем детали серии
    const seriesDetails = await getMatchDetails(seriesId, apiKey);
    
    if (seriesDetails && seriesDetails.matches) {
      // Ищем матчи этой серии среди доступных
      for (const matchId of Object.keys(seriesDetails.matches)) {
        if (availableMatchIds.has(matchId)) {
          const matchDetails = await getMatchDetails(matchId, apiKey);
          if (matchDetails) {
            seriesMatches.push({
              id: matchId,
              date: new Date(matchDetails.finished_at * 1000).toISOString(),
              map: getMapName(matchDetails),
              result: getMatchResult(matchDetails),
              score: matchDetails.results?.score || {}
            });
          }
        }
      }
    }
  } catch (error) {
    console.warn(`Error finding series matches for ${seriesId}:`, error.message);
  }
  
  return seriesMatches.sort((a, b) => new Date(a.date) - new Date(b.date));
}

function getOurPlayersInSeries(series, teamPlayerNames) {
  const playersInSeries = new Set();
  
  for (const match of series.matches) {
    const players = getPlayersFromMatch(match);
    players.forEach(player => {
      if (teamPlayerNames.has(player.nickname)) {
        playersInSeries.add(player.nickname);
      }
    });
  }
  
  return Array.from(playersInSeries);
}

function getPlayersFromMatch(match) {
  const players = [];
  
  // Для упрощения - используем базовую структуру
  // В реальности нужно адаптировать под структуру данных матча
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
  if (matchData.voting?.map?.pick?.[0]) {
    return matchData.voting.map.pick[0];
  }
  if (matchData.voting?.map?.entities?.[0]?.name) {
    return matchData.voting.map.entities[0].name;
  }
  if (matchData.voting?.map?.entities?.[0]?.guid) {
    const guid = matchData.voting.map.entities[0].guid;
    if (guid.includes('de_')) {
      return guid.split('_').slice(0, 2).join('_');
    }
    return guid;
  }
  return 'Unknown';
}

function getMatchResult(match) {
  if (!match.results?.winner) return 'Unknown';
  return match.results.winner;
}

function getSeriesResult(series) {
  const wins = series.matches.filter(m => m.result === 'win').length;
  const losses = series.matches.filter(m => m.result === 'loss').length;
  
  if (wins > losses) return 'Win';
  if (losses > wins) return 'Loss';
  return 'Draw';
}

function analyzeMapStatisticsFromSeries(series) {
  const mapStats = {};

  // Собираем статистику по всем картам из всех серий
  for (const seriesItem of series) {
    for (const match of seriesItem.matches) {
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

      if (match.result === 'win') {
        stats.wins++;
      } else if (match.result === 'loss') {
        stats.losses++;
      }

      stats.winRate = stats.totalMatches > 0 ? 
        Math.round((stats.wins / stats.totalMatches) * 100) : 0;
    }
  }

  return Object.values(mapStats)
    .sort((a, b) => b.totalMatches - a.totalMatches)
    .filter(map => map.map !== 'Unknown');
}