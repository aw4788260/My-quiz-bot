// =============================================================================
// 1. إعدادات وتأسيس
// =============================================================================
require('dotenv').config({ path: './1.env' }); // <-- تم التعديل هنا ليقرأ الملف بالاسم الجديد
const TelegramBot = require('node-telegram-bot-api');
const express = require('express');
const bodyParser = require('body-parser');
const admin = require('firebase-admin');
const cron = require('node-cron');

// --- المتغيرات الأساسية ---
const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const ADMIN_ID = process.env.ADMIN_ID;
const WEBHOOK_URL = process.env.WEBHOOK_URL;
const PORT = process.env.PORT || 10000;
const PAGE_SIZE = 10;

// --- التحقق من المتغيرات ---
if (!TOKEN || !ADMIN_ID || !WEBHOOK_URL || !process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
console.error("FATAL ERROR: Missing one or more required environment variables.");
process.exit(1);
}

// --- إعداد Firebase Admin SDK ---
try {
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
admin.initializeApp({
credential: admin.credential.cert(serviceAccount)
});
} catch (error) {
console.error("FATAL ERROR: Could not initialize Firebase Admin SDK. Check your FIREBASE_SERVICE_ACCOUNT_JSON.", error);
process.exit(1);
}
const db = admin.firestore();

// --- إعداد البوت و Express ---
const bot = new TelegramBot(TOKEN);
const app = express();
app.use(bodyParser.json());

// --- ربط الويب هوك (Webhook) ---
app.post(`/webhook/${TOKEN}`, (req, res) => {
bot.processUpdate(req.body);
res.sendStatus(200);
});

// =============================================================================
// 2. دوال مساعدة وقواعد البيانات
// =============================================================================

// --- دوال حالة المستخدم (State Management) ---
const userStateCollection = db.collection('userStates');
const getUserState = async (userId) => {
const doc = await userStateCollection.doc(userId.toString()).get();
return doc.exists ? doc.data() : null;
};
const setUserState = (userId, state, data = {}) => userStateCollection.doc(userId.toString()).set({ state, data });
const clearUserState = (userId) => userStateCollection.doc(userId.toString()).delete();

// --- دوال Firestore العامة ---
const getCollection = async (collectionName) => {
const snapshot = await db.collection(collectionName).get();
return snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
};

const getDocument = async (collectionName, docId) => {
const doc = await db.collection(collectionName).doc(docId).get();
return doc.exists ? { id: doc.id, ...doc.data() } : null;
};

// --- دوال المستخدمين ---
const isNewUser = async (userId) => !(await getDocument('users', userId.toString()));
const addNewUser = (user) => db.collection('users').doc(user.id.toString()).set({
userId: user.id.toString(),
username: user.username || '',
firstName: user.first_name,
joinTimestamp: admin.firestore.FieldValue.serverTimestamp()
});
const getUserCount = async () => (await db.collection('users').get()).size;

async function checkAndNotifyNewUser(user) {
if (await isNewUser(user.id)) {
await addNewUser(user);
const totalUsers = await getUserCount();
let notification = `👤 مستخدم جديد انضم!\n\n` + `الاسم: ${user.first_name}\n`;
if (user.username) notification += `المعرف: @${user.username}\n`;
notification += `الأي دي: \`${user.id}\`\n\n` + `*العدد الكلي للمستخدمين الآن: ${totalUsers}*`;
bot.sendMessage(ADMIN_ID, notification, { parse_mode: 'Markdown' });
}
}

// --- دوال الفئات (Categories) ---
const getAllCategories = async () => {
const categories = await getCollection('categories');
return categories.sort((a, b) => (a.displayOrder || 999) - (b.displayOrder || 999));
};
const addCategory = (name, order) => db.collection('categories').doc(name).set({ name, displayOrder: order });
// ... Add other category functions (rename, delete, reorder) here

// --- دوال الاختبارات والأسئلة ---
const getExam = (examId) => getDocument('exams', examId);
const getAllExams = () => getCollection('exams');
const getExamQuestions = async (examId) => {
const snapshot = await db.collection('questions').where('examId', '==', examId).get();
if (snapshot.empty) return [];
const questions = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
return questions.sort((a, b) => (a.order || 0) - (b.order || 0));
};
const parseSingleQuestion = (text) => {
const lines = text.trim().split('\n').filter(line => line.trim() !== '');
if (lines.length < 3) return null;
const questionText = lines[0].trim();
const correctOptionNumber = parseInt(lines[lines.length - 1], 10);
const options = lines.slice(1, -1).map(opt => opt.trim());
if (isNaN(correctOptionNumber) || correctOptionNumber < 1 || correctOptionNumber > options.length || options.length < 2 || options.length > 10) return null;
const correctOptionIndex = correctOptionNumber - 1;
return { questionText, options: JSON.stringify(options), correctOptionIndex };
};

// =============================================================================
// 3. معالجات الرسائل والأوامر
// =============================================================================

bot.onText(/\/start/, async (msg) => {
const chatId = msg.chat.id.toString();
await checkAndNotifyNewUser(msg.from);
await clearUserState(chatId);
sendMainMenu(chatId);
});

bot.onText(/\/usercount/, async (msg) => {
if (msg.chat.id.toString() === ADMIN_ID) {
const count = await getUserCount();
bot.sendMessage(ADMIN_ID, `📊 العدد الكلي للمستخدمين هو: *${count}*`, { parse_mode: 'Markdown' });
}
});

bot.on('message', async (msg) => {
if (!msg.text || msg.text.startsWith('/')) return;
const chatId = msg.chat.id.toString();
const text = msg.text;
const userState = await getUserState(chatId);
if (!userState) return;

// --- State Handling for Text Messages ---
if (userState.state === 'awaiting_questions') {
await addBulkQuestionsFromText(chatId, text, userState);
} else if (userState.state === 'awaiting_exam_name') {
await handleNewExamName(chatId, text, userState);
}
// ... Add all other state handlers here
else {
// Fallback for unhandled states
await bot.sendMessage(chatId, "I'm not sure what to do with this. Please start over.");
await clearUserState(chatId);
}
});

bot.on('callback_query', async (callbackQuery) => {
const chatId = callbackQuery.from.id.toString();
const messageId = callbackQuery.message.message_id;
const data = callbackQuery.data;
const [action, param1, param2] = data.split(':');

bot.answerCallbackQuery(callbackQuery.id);

// --- State Handling for Callbacks ---
switch (action) {
case 'admin_panel':
case 'back_to_admin_panel':
await sendAdminMenu(chatId, messageId);
break;
case 'student_panel':
await sendStudentMenu(chatId, messageId);
break;
case 'back_to_main':
await sendMainMenu(chatId, messageId);
break;
case 'admin_add_exam':
await startAddExamFlow(chatId);
break;
case 'set_retake':
await handleSetRetake(chatId, param1, messageId);
break;
case 'set_time':
await handleSetTime(chatId, param1, messageId);
break;
case 'finish_adding_questions':
await finishAddingQuestions(chatId);
break;
case 'student_list_exams':
await listExamsForStudent(chatId, messageId);
break;
case 'list_exams_in_category':
await listExamsInCategory(chatId, param1, messageId, parseInt(param2 || '1'));
break;
case 'show_exam_confirm':
await showExamConfirmation(chatId, param1, messageId);
break;
case 'confirm_start_exam':
await startQuiz(callbackQuery);
break;
// ... Add all other callback handlers here
default:
await bot.sendMessage(chatId, `Action "${action}" is not implemented yet.`);
break;
}
});

bot.on('poll_answer', async (pollAnswer) => {
const userId = pollAnswer.user.id.toString();
const userState = await getUserState(userId);
if (!userState || userState.state !== 'taking_exam') return;

const { questions, currentQuestionIndex } = userState.data;
const currentQuestion = questions[currentQuestionIndex];
const selectedOptionIndex = pollAnswer.option_ids[0];

if (selectedOptionIndex !== undefined && selectedOptionIndex == currentQuestion.correctOptionIndex) {
userState.data.score++;
}

if (userState.data.timePerQuestion === 0) {
// For non-timed quizzes, advance immediately
await advanceQuiz(userId, userState);
} else {
// For timed quizzes, the cron job will handle advancing.
// We just update the score.
await setUserState(userId, 'taking_exam', userState.data);
}
});

// =============================================================================
// 4. دوال القوائم والواجهات
// =============================================================================

const sendMainMenu = async (chatId, messageId = null) => {
const text = "👋 أهلاً بك في بوت الاختبارات!\n\nاختر الواجهة المناسبة لك:";
const keyboard = {
inline_keyboard: (chatId === ADMIN_ID)
? [[{ text: "👑 لوحة تحكم الأدمن", callback_data: "admin_panel" }], [{ text: "🎓 واجهة الطالب", callback_data: "student_panel" }]]
: [[{ text: "🎓 الدخول للاختبارات", callback_data: "student_panel" }]]
};
await sendOrEditMessage(chatId, text, { reply_markup: keyboard }, messageId);
};

const sendAdminMenu = async (chatId, messageId) => {
const text = "👑 لوحة تحكم الأدمن\n\nاختر الإجراء الذي تريد القيام به:";
const keyboard = {
inline_keyboard: [
[{ text: "➕ إضافة اختبار جديد", callback_data: "admin_add_exam" }],
[{ text: "📋 عرض وتعديل الاختبارات", callback_data: "admin_list_exams:1" }],
[{ text: "🗂️ إدارة الفئات", callback_data: "manage_categories" }],
[{ text: "⬅️ العودة للقائمة الرئيسية", callback_data: "back_to_main" }]
]
};
await sendOrEditMessage(chatId, text, { reply_markup: keyboard }, messageId);
};

const sendStudentMenu = async (chatId, messageId) => {
const text = "🎓 واجهة الطالب\n\nمرحباً بك!";
const keyboard = {
inline_keyboard: [
[{ text: "📝 بدء اختبار", callback_data: "student_list_exams" }],
[{ text: "📊 عرض نتائجي السابقة", callback_data: "student_stats" }],
]
};
if (chatId === ADMIN_ID) {
keyboard.inline_keyboard.push([{ text: "⬅️ العودة للقائمة الرئيسية", callback_data: "back_to_main" }]);
}
await sendOrEditMessage(chatId, text, { reply_markup: keyboard }, messageId);
};

const sendOrEditMessage = async (chatId, text, options = {}, messageId = null) => {
try {
if (messageId) {
return await bot.editMessageText(text, { chat_id: chatId, message_id: messageId, ...options });
} else {
return await bot.sendMessage(chatId, text, options);
}
} catch (error) {
console.error(`Error sending/editing message for chat ${chatId}:`, error.message);
if (error.code === 'ETELEGRAM' && error.response.body.description.includes('message is not modified')) {
// This is okay, just means the content is the same.
} else if (messageId) {
return await bot.sendMessage(chatId, text, options);
}
}
};

// =============================================================================
// 5. منطق إدارة الاختبارات
// =============================================================================

const startAddExamFlow = async (chatId) => {
await setUserState(chatId, 'awaiting_exam_name', {});
await bot.sendMessage(chatId, "📝 لنبدأ بإضافة اختبار جديد.\n\nالرجاء إرسال **اسم الاختبار** (سيكون فريدًا لكل اختبار).", { parse_mode: "Markdown" });
};

const handleNewExamName = async (chatId, text, userState) => {
const examId = text.trim();
if (await getExam(examId)) {
await bot.sendMessage(chatId, "⚠️ اسم الاختبار هذا مستخدم بالفعل. الرجاء اختيار اسم آخر.");
return;
}
userState.data.examId = examId;
await setUserState(chatId, 'awaiting_retake_choice', userState.data);
await promptForRetake(chatId);
};

const promptForRetake = async (chatId, messageId = null) => {
const text = "🔁 هل تسمح للطلاب بإعادة هذا الاختبار؟";
const keyboard = { inline_keyboard: [[{ text: "✅ نعم، اسمح بالإعادة", callback_data: "set_retake:true" }], [{ text: "❌ لا، مرة واحدة فقط", callback_data: "set_retake:false" }]]};
await sendOrEditMessage(chatId, text, { reply_markup: keyboard }, messageId);
};

const handleSetRetake = async (chatId, allowRetake, messageId) => {
const userState = await getUserState(chatId);
if (!userState || userState.state !== 'awaiting_retake_choice') return;
userState.data.allowRetake = (allowRetake === 'true');
await setUserState(chatId, 'awaiting_time_choice', userState.data);
await promptForTime(chatId, messageId);
};

const promptForTime = async (chatId, messageId = null) => {
const text = "⏰ هل تريد تحديد وقت لكل سؤال؟";
const keyboard = { inline_keyboard: [[{ text: "⏱️ نعم، حدد وقت", callback_data: "set_time:true" }], [{ text: "♾️ لا، وقت مفتوح", callback_data: "set_time:false" }]]};
await sendOrEditMessage(chatId, text, { reply_markup: keyboard }, messageId);
};

const handleSetTime = async (chatId, wantsTime, messageId) => {
const userState = await getUserState(chatId);
if (!userState || userState.state !== 'awaiting_time_choice') return;
if (wantsTime === 'true') {
await setUserState(chatId, 'awaiting_time_per_question', userState.data);
await sendOrEditMessage(chatId, "⏱️ ممتاز. الرجاء إرسال عدد الثواني المخصصة لكل سؤال (مثال: 30).", {}, messageId);
} else {
userState.data.time = 0;
await setUserState(chatId, 'selecting_category', userState.data);
await bot.sendMessage(chatId, "Category selection is not implemented yet.");
}
};

const addBulkQuestionsFromText = async (chatId, text, userState) => {
const questionBlocks = text.trim().split('---');
let successCount = 0; let failCount = 0;
if (!userState.data.questions) userState.data.questions = [];

for (const block of questionBlocks) {
if (block.trim() === '') continue;
const parsedQuestion = parseSingleQuestion(block);
if (parsedQuestion) {
userState.data.questions.push(parsedQuestion);
successCount++;
} else {
failCount++;
}
}
await setUserState(chatId, userState.state, userState.data);
let summaryMessage = `تمت معالجة الأسئلة:\n`;
if (successCount > 0) summaryMessage += `✅ نجح إضافة: ${successCount} سؤال.\n`;
if (failCount > 0) summaryMessage += `⚠️ فشل إضافة: ${failCount} سؤال.\n`;
summaryMessage += `إجمالي الأسئلة الآن: ${userState.data.questions.length}.\nأرسل المزيد أو اضغط إنهاء.`;
const keyboard = { inline_keyboard: [[{ text: "✅ تم، إنهاء إضافة الأسئلة", callback_data: "finish_adding_questions" }]] };
await bot.sendMessage(chatId, summaryMessage, { reply_markup: keyboard });
};

const finishAddingQuestions = async (chatId) => {
const userState = await getUserState(chatId);
if (!userState || userState.state !== 'awaiting_questions' || !userState.data.questions || userState.data.questions.length === 0) {
await bot.sendMessage(chatId, "⚠️ لم تقم بإضافة أي أسئلة! تم إلغاء إنشاء الاختبار.");
await clearUserState(chatId);
await sendAdminMenu(chatId);
return;
}

const { examId, allowRetake, time, categoryName, questions } = userState.data;
const examData = { examId, allowRetake, timePerQuestion: time, categoryName: categoryName || "Uncategorized", questionCount: questions.length };

const batch = db.batch();
const examRef = db.collection('exams').doc(examId);
batch.set(examRef, examData);

questions.forEach((q, index) => {
const questionRef = db.collection('questions').doc(); // Auto-generate ID
const questionData = { examId, questionText: q.questionText, options: q.options, correctOptionIndex: q.correctOptionIndex, order: index + 1 };
batch.set(questionRef, questionData);
});

await batch.commit();
await clearUserState(chatId);
await bot.sendMessage(chatId, `🎉 تم إنشاء الاختبار **${examId}** بنجاح مع ${questions.length} سؤال.`, { parse_mode: "Markdown" });
await sendAdminMenu(chatId);
};

// =============================================================================
// 6. منطق الطالب والاختبار
// =============================================================================

const listExamsForStudent = async (chatId, messageId) => {
const categories = await getAllCategories();
if (categories.length === 0) {
await sendOrEditMessage(chatId, "لا توجد أي فئات اختبارات متاحة حاليًا.", { reply_markup: { inline_keyboard: [[{text: "⬅️ رجوع", callback_data: "student_panel"}]]}}, messageId);
return;
}
const text = "🗂️ يرجى اختيار فئة الاختبارات التي تريد عرضها:";
const keyboard = { inline_keyboard: categories.map(cat => ([{ text: cat.name, callback_data: `list_exams_in_category:${cat.id}:1` }])) };
keyboard.inline_keyboard.push([{ text: "⬅️ رجوع", callback_data: "student_panel" }]);
await sendOrEditMessage(chatId, text, { reply_markup: keyboard }, messageId);
};

const listExamsInCategory = async (chatId, categoryName, messageId, page = 1) => {
const allExams = await getAllExams();
const examsInCategory = allExams.filter(exam => exam.categoryName === categoryName);

if (examsInCategory.length === 0) {
await sendOrEditMessage(chatId, `لا توجد اختبارات في فئة *${categoryName}* حاليًا.`, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: "⬅️ رجوع للفئات", callback_data: "student_list_exams" }]]}}, messageId);
return;
}

const totalPages = Math.ceil(examsInCategory.length / PAGE_SIZE);
const examsToShow = examsInCategory.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
const text = `📝 اختر الاختبار الذي تريد عرضه من فئة *${categoryName}*:`;
const keyboardRows = examsToShow.map(exam => ([{ text: exam.examId, callback_data: `show_exam_confirm:${exam.id}` }]));

const navRow = [];
if (page > 1) navRow.push({ text: "◀️ السابق", callback_data: `list_exams_in_category:${categoryName}:${page - 1}` });
navRow.push({ text: `صفحة ${page}/${totalPages}`, callback_data: "noop" });
if (page < totalPages) navRow.push({ text: "التالي ▶️", callback_data: `list_exams_in_category:${categoryName}:${page + 1}` });
if (navRow.length > 0) keyboardRows.push(navRow);

keyboardRows.push([{ text: "⬅️ رجوع للفئات", callback_data: "student_list_exams" }]);
await sendOrEditMessage(chatId, text, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: keyboardRows } }, messageId);
};

const showExamConfirmation = async (chatId, examId, messageId) => {
const exam = await getExam(examId);
if (!exam) return;
let text = `*تفاصيل الاختبار: ${exam.examId}*\n\n`;
text += `*عدد الأسئلة:* ${exam.questionCount}\n`;
text += `*الوقت لكل سؤال:* ${exam.timePerQuestion > 0 ? `${exam.timePerQuestion} ثانية` : '♾️ وقت مفتوح'}\n\n`;
text += `هل أنت مستعد للبدء؟`;
const keyboard = { inline_keyboard: [[{ text: "🚀 بدء الاختبار الآن", callback_data: `confirm_start_exam:${examId}` }], [{ text: "⬅️ رجوع", callback_data: `list_exams_in_category:${exam.categoryName}:1` }]]};
await sendOrEditMessage(chatId, text, { parse_mode: 'Markdown', reply_markup: keyboard }, messageId);
};

const startQuiz = async (callbackQuery) => {
const chatId = callbackQuery.from.id.toString();
const userName = callbackQuery.from.username || callbackQuery.from.first_name;
const examId = callbackQuery.data.split(':')[1];
const exam = await getExam(examId);
if (!exam) return;

const questions = await getExamQuestions(examId);
if (questions.length === 0) {
await bot.answerCallbackQuery(callbackQuery.id, "⚠️ عذراً، هذا الاختبار لا يحتوي على أسئلة حاليًا.", { show_alert: true });
return;
}

await sendOrEditMessage(chatId, `🚀 سيبدأ اختبار **${examId}** الآن. استعد!`, { parse_mode: 'Markdown' }, callbackQuery.message.message_id);

await setUserState(chatId, 'taking_exam', {
examId,
userName,
currentQuestionIndex: 0,
score: 0,
questions,
timePerQuestion: exam.timePerQuestion
});

await sendQuestion(chatId, await getUserState(chatId));
};

const sendQuestion = async (userId, userState) => {
const { currentQuestionIndex, questions, timePerQuestion } = userState.data;

if (currentQuestionIndex >= questions.length) {
await finishQuiz(userId, userState);
return;
}

userState.data.lastQuestionTimestamp = new Date().getTime();
await setUserState(userId, 'taking_exam', userState.data);

const question = questions[currentQuestionIndex];
const questionText = `*السؤال ${currentQuestionIndex + 1}:*\n\n${question.questionText}`;
const options = JSON.parse(question.options);

const pollOptions = {
is_anonymous: false,
type: 'quiz',
correct_option_id: question.correctOptionIndex
};
if (timePerQuestion > 0) {
pollOptions.open_period = timePerQuestion;
}

await bot.sendPoll(userId, questionText, options, pollOptions, { parse_mode: 'Markdown' });
};

const advanceQuiz = async (userId, userState) => {
userState.data.currentQuestionIndex++;
await setUserState(userId, 'taking_exam', userState.data);
await sendQuestion(userId, userState);
};

const finishQuiz = async (userId, userState) => {
const { examId, score, userName, questions } = userState.data;
const totalQuestions = questions.length;
// saveScore(userId, userName, examId, score, totalQuestions); // Implement this
await clearUserState(userId);
const text = `🎉 **انتهى الاختبار!** 🎉\n\nنتيجتك هي: *${score}* من *${totalQuestions}*`;
const keyboard = { inline_keyboard: [[{ text: "العودة للقائمة", callback_data: 'student_panel' }]] };
await bot.sendMessage(userId, text, { parse_mode: 'Markdown', reply_markup: keyboard });
};

// =============================================================================
// 7. المهام المجدولة (Cron Jobs)
// =============================================================================

cron.schedule('* * * * *', async () => {
console.log('Running timed-out quiz check...');
const now = new Date().getTime();
const snapshot = await userStateCollection.where('state', '==', 'taking_exam').get();
if (snapshot.empty) return;

snapshot.forEach(async (doc) => {
const userId = doc.id;
const state = doc.data();
const { lastQuestionTimestamp, timePerQuestion } = state.data;

if (lastQuestionTimestamp && timePerQuestion > 0) {
const timeElapsed = (now - lastQuestionTimestamp) / 1000;
if (timeElapsed > timePerQuestion + 3) { // 3 second grace period
console.log(`User ${userId} timed out. Advancing quiz.`);
await advanceQuiz(userId, state);
}
}
});
});

// =============================================================================
// 8. تشغيل الخادم
// =============================================================================

app.listen(PORT, async () => {
console.log(`Server is running on port ${PORT}`);
try {
const fullWebhookUrl = `${WEBHOOK_URL}/webhook/${TOKEN}`;
await bot.setWebHook(fullWebhookUrl);
console.log(`Webhook successfully set to ${fullWebhookUrl}`);
} catch (error) {
console.error("Error setting webhook:", error.message);
}
});
