const express = require("express");
const cors = require("cors");
const axios = require("axios");
const translate = require("translate-google");

const { initializeApp, cert } = require("firebase-admin/app");
const { getFirestore } = require("firebase-admin/firestore");

const serviceAccount = JSON.parse(
  process.env.FIREBASE_SERVICE_ACCOUNT
);

initializeApp({
  credential: cert(serviceAccount),
});

const db = getFirestore();

const app = express();
app.use(cors());
app.use(express.json());
const apiKey = "ca3f89bff6484d5d92d0c15e69cb6a9c";

function randomMarket() {
  const markets = ["Aldi", "Lidl", "Rewe", "Edeka"];
  return markets[Math.floor(Math.random() * markets.length)];
}

function cleanHtml(text) {
  if (!text) return "";
  return text.replace(/<[^>]*>/g, "").replace(/&nbsp;/g, " ");
}

async function toGerman(text) {
  if (!text) return "";
  try {
    return await translate(text, { to: "de" });
  } catch {
    return text;
  }
}

function addToShoppingList(list, ingredients) {
  for (const item of ingredients) {
    const name = item.nameClean || item.name;
    const amount = item.amount || 1;
    const unit = item.unit || "Stück";

    if (!list[name]) {
      list[name] = { amount, unit };
    } else if (list[name].unit === unit) {
      list[name].amount += amount;
    }
  }
}

app.get("/", (req, res) => {
  res.send("SmartSaver Backend läuft ✅");
});

app.get("/firebase-test", async (req, res) => {
  try {
    await db.collection("test").add({
      message: "Firebase funktioniert",
      createdAt: new Date(),
    });

    res.send("Firebase OK ✅");
  } catch (error) {
    console.error(error);
    res.status(500).send("Firebase Fehler");
  }
});

app.get("/import-recipes", async (req, res) => {
  try {
    const response = await axios.get(
      "https://api.spoonacular.com/recipes/complexSearch",
      {
        params: {
          apiKey,
          number: 50,
          addRecipeInformation: true,
          fillIngredients: true,
        },
      }
    );

    let imported = 0;

    for (const recipe of response.data.results) {
      const nameDe = await toGerman(recipe.title);
      const stepsDe = await toGerman(cleanHtml(recipe.summary));

      const ingredients = {};
      const ingredientsDe = [];

      for (const ing of recipe.extendedIngredients || []) {
        const deName = await toGerman(ing.nameClean || ing.name);
        ingredients[deName] = `${ing.amount || 1} ${ing.unit || "Stück"}`;
        ingredientsDe.push({
          name: deName,
          amount: ing.amount || 1,
          unit: ing.unit || "Stück",
        });
      }

      await db.collection("recipes").add({
        originalId: recipe.id,
        name: nameDe,
        originalName: recipe.title,
        image: recipe.image,
        cookTime: recipe.readyInMinutes || 30,
        price: Number(((recipe.pricePerServing || 300) / 100).toFixed(2)),
        market: randomMarket(),

        vegetarian: recipe.vegetarian || false,
        vegan: recipe.vegan || false,
        glutenFree: recipe.glutenFree || false,
        lactoseFree: recipe.dairyFree || false,

        ingredients,
        ingredientsList: ingredientsDe,
        steps: stepsDe,

        createdAt: new Date(),
      });

      imported++;
    }

    res.send(`${imported} Rezepte wurden in Firebase gespeichert ✅`);
  } catch (error) {
    console.error(error.response?.data || error.message);
    res.status(500).send("Import fehlgeschlagen");
  }
});

app.post("/mealplan", async (req, res) => {
  try {
    const budget = Number(req.body.budget || 50);
    const persons = Number(req.body.persons || 2);

    const snapshot = await db.collection("recipes").get();

    let recipes = snapshot.docs.map((doc) => ({
      id: doc.id,
      ...doc.data(),
    }));

    recipes = recipes.filter((recipe) => {
      if (req.body.vegan && !recipe.vegan) return false;
      if (req.body.vegetarian && !recipe.vegetarian) return false;
      if (req.body.glutenFree && !recipe.glutenFree) return false;
      if (req.body.lactoseFree && !recipe.lactoseFree) return false;
      if (req.body.market && req.body.market !== "Alle" && recipe.market !== req.body.market) return false;
      if (req.body.cookTime && req.body.cookTime !== "Beliebig" && recipe.cookTime > Number(req.body.cookTime)) return false;

      return true;
    });

    recipes.sort((a, b) => a.price - b.price);

    const selectedRecipes = [];
    const shoppingList = {};
    let totalPrice = 0;

    for (const recipe of recipes) {
      if (selectedRecipes.length >= 7) break;

      const adjustedPrice = recipe.price * (persons / 2);

      if (totalPrice + adjustedPrice <= budget) {
        selectedRecipes.push(recipe);
        totalPrice += adjustedPrice;

        addToShoppingList(shoppingList, recipe.ingredientsList || []);
      }
    }

    const savedMoney = Math.max(0, budget - totalPrice);

    res.json({
      recipes: selectedRecipes,
      shoppingList,
      totalPrice: Number(totalPrice.toFixed(2)),
      savedMoney: Number(savedMoney.toFixed(2)),
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({
      error: "Wochenplan konnte nicht erstellt werden",
    });
  }
});

app.listen(3000, "0.0.0.0", () => {
  console.log("SmartSaver Backend läuft auf http://localhost:3000");
});