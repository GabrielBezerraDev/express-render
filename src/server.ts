import express, { Request, Response } from 'express';
import http from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import dotenv from 'dotenv';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { createClient } from '@supabase/supabase-js';

dotenv.config();

const app = express();
const server = http.createServer(app);
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'fallback_secret';

// ==========================================
// 1. CONFIGURAÇÃO DO SUPABASE
// ==========================================
const supabaseUrl = process.env.SUPABASE_URL!;
const supabaseKey = process.env.SUPABASE_KEY!; // Use a chave "service_role" ou "anon" (Service role é melhor pro backend pois ignora RLS)

if (!supabaseUrl || !supabaseKey) {
  throw new Error('Faltam as variáveis SUPABASE_URL e SUPABASE_KEY no .env');
}

const supabase = createClient(supabaseUrl, supabaseKey);

// ==========================================
// 2. CONFIGURAÇÕES SOCKET E MEMÓRIA
// ==========================================
const dataInMemory: Record<string, any> = {};

app.use(cors());
app.use(express.json());

// Socket Types (Mantive os mesmos)
interface ServerToClientEvents {
  palete_movimentado: (dados: { id: number; lat: number; lng: number }) => void;
  erro_sistema: (msg: string) => void;
}
interface ClientToServerEvents {
  update_position: (data: { userId: number; lat: number; lng: number, tripId: string }) => void;
  solicitar_lista: () => void;
}
interface SocketData {
  userId: string;
}

const io = new Server<ClientToServerEvents, ServerToClientEvents, {}, SocketData>(server, {
  cors: { origin: "*", methods: ["GET", "POST"] }
});

// ==========================================
// 3. ROTAS DE AUTH (Customizada com Supabase DB)
// ==========================================

// ROTA: CADASTRO
app.post("/auth/register", async (req: Request, res: Response): Promise<any> => {
  try {
    const { email, password, firstName, lastName } = req.body;

    if (!email || !password || !firstName || !lastName) {
      return res.status(400).json({ error: "Algo deu errado!" });
    }

    // 1. Verificar se usuário já existe
    const { data: existingUser } = await supabase
      .from('users')
      .select('id')
      .eq('email', email)
      .single();

    if (existingUser) {
      return res.status(400).json({ error: "E-mail já cadastrado." });
    }

    // 2. Hash da senha (Bcrypt)
    const hashedPassword = await bcrypt.hash(password, 10);

    // 3. Inserir no Supabase
    const { data: newUser, error } = await supabase
      .from('users')
      .insert([
        { email, password: hashedPassword, first_name: firstName, last_name: lastName }
      ])
      .select() // Retorna o usuário criado
      .single();

    if (error) {
      throw error;
    }

    // 4. Gerar Token JWT
    const token = jwt.sign({ id: newUser.id, email: newUser.email, firstName: newUser.first_name, lastName: newUser.last_name }, JWT_SECRET, {
      expiresIn: '7d',
    });

    return res.status(201).json({
      message: "Usuário criado com sucesso",
      user: { id: newUser.id, email: newUser.email, firstName: newUser.first_name, lastName: newUser.last_name },
      token
    });

  } catch (error: any) {
    console.error(error);
    return res.status(500).json({ error: "Erro ao criar conta", details: error.message });
  }
});

// ROTA: LOGIN
app.post("/auth/login", async (req: Request, res: Response): Promise<any> => {
  try {
    const { email, password } = req.body;

    // 1. Buscar usuário no Supabase
    const { data: user, error } = await supabase
      .from('users')
      .select('*')
      .eq('email', email)
      .single();

    if (error || !user) {
      return res.status(401).json({ error: "Credenciais inválidas" });
    }

    // 2. Comparar senha (Bcrypt)
    const isPasswordValid = await bcrypt.compare(password, user.password);

    if (!isPasswordValid) {
      return res.status(401).json({ error: "Credenciais inválidas" });
    }

    // 3. Gerar Token JWT
    const token = jwt.sign({ id: user.id, email: user.email, firstName: user.first_name, lastName: user.last_name }, JWT_SECRET, {
      expiresIn: '7d',
    });

    // Decodifica só para retornar no payload como você pediu
    const payload = jwt.decode(token);

    return res.json({
      message: "Login realizado",
      token,
      payload
    });

  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: "Erro interno do servidor" });
  }
});

app.get("/api/trips", async (req: Request, res: Response): Promise<any> => {
  try {
    // Consulta a VIEW que criamos no Supabase
    // O Supabase JS trata views exatamente como tabelas
    const { data, error } = await supabase
      .from('trips_summary')
      .select('*');

    if (error) throw error;

    return res.json(data);
  } catch (error: any) {
    console.error("Erro ao buscar viagens:", error);
    return res.status(500).json({ error: "Erro ao buscar histórico de viagens" });
  }
});

// 2. DETALHES DA VIAGEM (Coordenadas para o Mapa)
app.get("/api/trips/:tripId", async (req: Request, res: Response): Promise<any> => {
  try {
    const { tripId } = req.params;

    // Busca apenas latitude e longitude ordenadas por tempo
    const { data, error } = await supabase
      .from('coordinates')
      .select('lat, lng')
      .eq('trip_id', tripId)
      .order('created_at', { ascending: true });

    if (error) throw error;

    // Formata para o padrão simples que o App espera: [[lng, lat], [lng, lat]]
    const formattedPath = data?.map(p => [p.lng, p.lat]) || [];

    return res.json(formattedPath);
  } catch (error: any) {
    console.error("Erro ao buscar rota:", error);
    return res.status(500).json({ error: "Erro ao carregar rota da viagem" });
  }
});

// ==========================================
// 4. LÓGICA DO WEBSOCKET
// ==========================================
io.on("connection", (socket) => {
  console.log(`🔌 Cliente conectado: ${socket.id}`);

  socket.on("update_position", async (data) => {
    console.log("📍 Recebido:", data);

    try {
      const { error } = await supabase
        .from('coordinates')
        .insert({
          user_id: data.userId,
          trip_id: data.tripId,
          lat: data.lat,
          lng: data.lng
        });

      if (error) {
        console.error("Erro ao salvar coordenada:", error.message);
      }
    } catch (err) {
      console.error("Erro interno ao salvar:", err);
    }



  });

  socket.on("disconnect", () => {
    console.log(`❌ Cliente desconectou: ${socket.id}`);
  });
});

// ==========================================
// 5. START
// ==========================================
server.listen(PORT, () => {
  console.log(`✅ Servidor rodando na porta ${PORT}`);
});