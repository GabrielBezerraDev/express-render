import express, { Request, Response } from 'express';
import http from 'http';
import { Server, Socket } from 'socket.io';
import cors from 'cors';
import dotenv from 'dotenv';

dotenv.config();

// ==========================================
// 1. Definição dos Tipos (O "Contrato" de Eventos)
// ==========================================

// O que o Servidor envia para o Cliente (App/Admin)
interface ServerToClientEvents {
  // Ex: "O servidor avisa: o palete X mudou de lugar"
  palete_movimentado: (dados: { id: string; lat: number; lng: number }) => void;
  
  // Ex: "O servidor avisa: erro ao processar"
  erro_sistema: (msg: string) => void;
}

// O que o Cliente (App) envia para o Servidor
interface ClientToServerEvents {
  // Ex: "O App avisa: estou na posição tal"
  update_position: (data: { userId:string, lat: number; lng: number }) => void;
  
  // Ex: "O Admin pede: me dá a lista toda agora"
  solicitar_lista: () => void;
}

// Dados internos do socket (ex: ID do usuário logado)
interface SocketData {
  userId: string;
}

// ==========================================
// 2. Setup do Express + HTTP
// ==========================================
const app = express();
const server = http.createServer(app); // WebSocket precisa desse server cru
const PORT = process.env.PORT || 3000;

const dataInMemory: Record<string,any> = {};

app.use(cors());
app.use(express.json());

// ==========================================
// 3. Setup do Socket.io com Tipagem
// ==========================================
const io = new Server<
  ClientToServerEvents,
  ServerToClientEvents,
  {},
  SocketData
>(server, {
  cors: {
    origin: "*", // ⚠️ Em produção, mude para o domínio do seu site Admin
    methods: ["GET", "POST"]
  }
});

// ==========================================
// 4. Lógica do WebSocket (Real-Time)
// ==========================================
io.on("connection", (socket) => {
  console.log(`🔌 Cliente conectado: ${socket.id}`);

  // O App (React Native) mandou "atualizar_posicao"
  socket.on("update_position", (data) => {
    // console.log(`📦 Palete ${dados.id} moveu para:`, dados.lat, dados.lng);
    console.log("Dados do Front: ", data);  
    
    dataInMemory[`${data.userId}`] = {
      lat: data.lat,
      lng: data.lng
    }

    // O Servidor replica isso para TODOS (Broadcast) -> O Admin vê mexendo
    // socket.broadcast.emit envia para todos MENOS quem mandou
    // io.emit envia para TODOS (incluindo quem mandou)
    // socket.broadcast.emit("palete_movimentado", dados);

    
  });

  

  socket.on("disconnect", () => {
    console.log(`❌ Cliente desconectou: ${socket.id}`);
  });
});

// ==========================================
// 5. Rotas HTTP Normais (Opcional)
// ==========================================
// Você pode misturar rotas normais com WebSocket sem problemas
app.get("/", (req: Request, res: Response) => {
  res.send("🚀 Backend Logística (HTTP + WS) Rodando!");
});

// Exemplo: Admin força uma atualização via API REST
app.post("/api/admin/resetar", (req, res) => {
  // Posso emitir um evento para todos os apps conectados via rota HTTP!
  io.emit("erro_sistema", "Sistema reiniciando, aguarde...");
  res.json({ ok: true });
});

// ==========================================
// 6. Start
// ==========================================
// IMPORTANTE: Use server.listen, NÃO app.listen
server.listen(PORT, () => {
  console.log(`✅ Servidor rodando na porta ${PORT}`);
  console.log(`📡 WebSocket pronto para conexões`);
});