# Asistente de IA para tu flotilla — Guía de conexión con ChatGPT

Conecta ChatGPT con la plataforma de rastreo para consultar tu flotilla en lenguaje natural, sin
entrar a los reportes ni aplicar filtros.

En lugar de navegar por menús, preguntas directamente:

> ¿Qué unidades están en línea ahorita?
> ¿Dónde está la unidad #12?
> ¿Cuántos kilómetros recorrió la flotilla la semana pasada?
> Mándame por correo el reporte de viajes de ayer.
> ¿Qué unidades generaron alarmas anoche?

**Solo verás las unidades a las que tu cuenta ya tiene acceso.** El conector usa tu token personal
y respeta exactamente los mismos permisos que tienes en la plataforma web: no muestra más de lo que
ya puedes ver, y tus compañeros no pueden ver tu información desde sus cuentas.

---

## Antes de empezar

Necesitas:

- **Una cuenta activa** en la plataforma de rastreo.
- **Un plan de ChatGPT que permita MCPs personalizados.** Esta función no está disponible en el
  plan gratuito. Si al buscar `MCP` en la configuración no aparece nada, es por el plan.

---

## Paso 1 — Genera tu token

El token es la llave que le da acceso a ChatGPT a tu cuenta.

1. Entra a la plataforma de rastreo desde tu navegador.
2. Ve a **Configuración → Preferencias**.
3. Elige una **fecha de expiración**. Escoge una fecha lejana (varios meses adelante); cuando esa
   fecha llegue, el conector dejará de funcionar sin avisarte.
4. Haz clic en **Generar** y luego **copia** el token completo.

> **Trátalo como tu contraseña.** Da acceso a tu cuenta. No lo compartas por WhatsApp, ni por correo,
> ni lo pegues en un documento compartido, ni lo muestres al compartir pantalla.
>
> Si crees que alguien más lo vio, regresa a esta misma pantalla y genera uno nuevo: eso cancela
> automáticamente el anterior.

Un detalle que causa confusión: el token es una cadena **muy larga**. Asegúrate de copiarlo completo,
de principio a fin. Si lo cortas a la mitad, el conector marcará error.

---

## Paso 2 — Agrega el MCP en ChatGPT

1. Abre la aplicación de ChatGPT y haz clic en **tu nombre de usuario**, luego en
   **Configuración** (Settings).
2. En el **buscador de la configuración**, escribe `MCP`.
3. Selecciona **MCPs**, dentro de la categoría **Plugins**.
4. En las pestañas de arriba, selecciona la pestaña **MCPs**.
5. Haz clic en **Agregar** (Add) → **MCP personalizado** (Custom MCP).
6. Llena los campos así:

   | Campo | Qué poner |
   | --- | --- |
   | **Nombre** | El que quieras, por ejemplo `Rastreo GDTrack` |
   | **Tipo de conexión** | **Streamable HTTP** |
   | **URL** | `https://gps.gdtrackpro.com.mx/mcp` |
   | **Bearer token** | El token que copiaste en el Paso 1 |

7. Haz clic en **Guardar** (Save).
8. **Cierra ChatGPT por completo y vuelve a abrirlo.**

El último paso no es opcional: si no reinicias la aplicación, el MCP no aparece disponible en la
conversación aunque lo hayas guardado bien.

Dos detalles que suelen fallar:

- El **tipo de conexión debe ser Streamable HTTP**. Si eliges otro, no conectará.
- La **URL termina en `/mcp`**, sin diagonal al final.

---

## Paso 3 — Pruébalo

Abre una conversación nueva y pregunta:

> ¿Qué unidades están en línea ahorita?

Si te responde con tus unidades, ya quedó. Si no, revisa la sección de problemas comunes.

---

## Qué puedes preguntar

**Ubicación en tiempo real**
> ¿Dónde está la unidad #12?
> ¿Qué unidades están en línea?
> ¿Cuáles unidades llevan más de un día sin reportar?

**Recorridos y actividad**
> ¿Cuántos kilómetros recorrió la unidad #10 la semana pasada?
> ¿Dónde se detuvo el KANGOO ayer y por cuánto tiempo?
> Reconstruye el día de ayer de la unidad #1.

**Alarmas y eventos**
> ¿Qué alarmas hubo anoche?
> ¿Alguna unidad salió de su geocerca este fin de semana?

**Reportes por correo**
> Mándame por correo el reporte de viajes de la semana pasada.

Los reportes llegan al correo de tu cuenta, en formato de hoja de cálculo.

**Consejos para mejores respuestas**

- Usa el nombre tal como aparece en la plataforma. Si el nombre es ambiguo, el asistente te
  preguntará cuál de las unidades quisiste decir en lugar de adivinar.
- Puedes decir "ayer", "la semana pasada" o "los últimos 7 días" sin dar fechas exactas.
- Si algo no te cuadra, pídele que te muestre los datos: "¿de dónde sacaste ese número?".

---

## Qué NO hace

- **No programa reportes recurrentes.** Puede enviarte un reporte por correo cuando se lo pides, una
  vez. No puede dejarlo programado para que llegue cada lunes. Si alguna vez te dice que sí lo
  programó, repórtalo: es un error.
- **No envía comandos a las unidades.** No puede apagar motores, abrir seguros ni activar salidas.
- **No modifica nada.** No puede crear ni editar unidades, geocercas, conductores ni usuarios. Es
  solo de consulta.

---

## Privacidad — léelo antes de conectar

Cuando le haces una pregunta, la información necesaria para responderte —ubicaciones, nombres de
unidades, recorridos, conductores— **se envía a OpenAI**, la empresa detrás de ChatGPT, para poder
generar la respuesta.

Esto es igual que con cualquier otro conector de ChatGPT, pero conviene que lo sepas y lo consideres
antes de conectar, sobre todo si manejas información sensible de clientes o rutas.

Si tu empresa tiene políticas sobre a dónde puede salir la información de operaciones, consúltalo
antes de activarlo.

---

## Problemas comunes

| Qué ves | Qué significa | Cómo se resuelve |
| --- | --- | --- |
| `Unauthorized` o error 401 | El token venció o fue cancelado | Genera uno nuevo en Configuración → Preferencias |
| Dice que el token es inválido o está mal formado | Se copió incompleto | Cópialo otra vez, completo, y vuelve a pegarlo |
| No aparece la opción de MCPs | Tu plan de ChatGPT no la incluye | Requiere un plan de paga |
| Guardaste el MCP pero no aparece en el chat | Falta reiniciar | Cierra ChatGPT por completo y vuelve a abrirlo |
| No conecta y la URL está bien | Tipo de conexión equivocado | Debe ser **Streamable HTTP** |
| Responde que no encuentra herramientas | No se reinició la app, o la URL está mal | Verifica la URL y reinicia ChatGPT |
| Dice que no encuentra una unidad | Tu cuenta no tiene acceso a esa unidad | Pídele a tu administrador que te dé permiso |
| Responde "0 unidades" y sabes que sí tienes | Puede ser un error del sistema | Repórtalo con la pregunta exacta que hiciste |

---

## Reportar un problema

Es una herramienta nueva y tu retroalimentación sirve. Si algo sale mal, o si una respuesta te
parece equivocada, avísanos con:

1. La pregunta exacta que hiciste.
2. Lo que te respondió.
3. Lo que esperabas, y cómo lo sabes (por ejemplo: "en la plataforma dice 43 km ese día").
4. El nombre de la unidad y el periodo.

**Nunca incluyas tu token** en el reporte.

Lo más útil que puedes reportar: respuestas que suenan seguras pero traen números equivocados. Ese
es el tipo de error más difícil de detectar y el más importante de corregir.
